import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { conversationView, filteredConversations, summarize, recordReview, listQuerySchema } from '../src/domain.js';
import { sourceFingerprint } from '../src/evaluation-context.js';
import { startEvaluationBatch } from '../src/evaluation-service.js';

function fixture() {
  const state = createState(false);
  state.catalog = [
    { id: 'critical_event', type: 'Flag', mark: 'Crítico', polarity: 'contexto' },
    { id: 'normal_event', type: 'Flag', mark: '', polarity: 'negativo' },
    { id: 'positive_event', type: 'Flag', mark: '+', polarity: 'positivo' },
    { id: 'num_mensajes_cliente', type: 'Métrica', mark: '', polarity: 'contexto' },
    { id: 'tipo_interaccion', type: 'Descriptor', mark: '', polarity: 'contexto' },
  ].map((v, index) => ({ ...v, name: v.id, variable: v.id, family: 'Prueba', phase: 1, active: true, version: 1, method: v.type === 'Métrica' ? 'Código' : 'IA', definition: 'Definición de prueba.', condition: '', order: index }));
  state.catalogVersions = state.catalog.map(v => ({ id: `${v.id}:1`, itemId: v.id, version: 1, snapshot: structuredClone(v) }));
  const c = { id: 'case', country: 'HN', countryName: 'Honduras', agent: { id: 'agent', name: 'Agente demo' }, client: { name: 'Cliente demo' }, date: '2026-11-03', startedAt: '2026-11-03T12:00:00Z', completed: true, messages: [{ id: 'm', actor: 'cliente', text: 'Excelente atención', timestamp: '2026-11-03T12:00:00Z' }], topics: [], media: [], evaluationId: 'evaluation' };
  state.conversations = [c];
  const results = state.catalog.map(v => ({ variableId: v.id, method: v.method, status: 'evaluado', value: v.type === 'Descriptor' ? 'cotización' : 1, evidence: [{ messageId: 'm', quote: c.messages[0].text }], reason: 'Resultado sintético.' }));
  results[2].comparison = { agreement: 'agree-positive', detections: 2, votes: 2, expected: 2, missing: 0, label: 'Detectado por 2 modelos' };
  state.evaluations = [{ id: 'evaluation', conversationId: c.id, sourceHash: sourceFingerprint(c), catalogVersions: state.catalog.map(v => ({ id: v.id, version: 1, active: true })), results }];
  return { state, c };
}

test('positivos coexisten con alertas; métricas y descriptores nunca son marcas', () => {
  const { state, c } = fixture();
  const view = conversationView(state, c);
  assert.deepEqual([view.critical, view.normal, view.positive], [1, 1, 1]);
  assert.equal(view.marks.length, 3);
  assert.equal(view.dualDetected, true);
  assert.equal(Object.hasOwn(view, 'metrics'), false);
  assert.equal(Object.hasOwn(view, 'variables'), false);
  const detail = conversationView(state, c, undefined, true);
  assert.equal(detail.metrics.length, 1);
  assert.equal(detail.descriptors.length, 1);
  assert.equal(detail.metrics[0].result.value, 1);
  assert.equal(detail.metrics[0].kind, null);
  assert.equal(summarize([view]).withPositives, 1);
});

test('doble detección intersecta la misma variable, país, período y clasificación', () => {
  const { state } = fixture();
  assert.equal(filteredConversations(state, { agreement: 'both' }).length, 1);
  assert.equal(filteredConversations(state, { agreement: 'both', variable: 'critical_event' }).length, 0);
  assert.equal(filteredConversations(state, { agreement: 'both', classification: 'critical' }).length, 0);
  assert.equal(filteredConversations(state, { agreement: 'both', variable: 'positive_event', classification: 'positive', country: 'HN' }).length, 1);
  assert.equal(filteredConversations(state, { agreement: 'both', country: 'CR' }).length, 0);
  assert.equal(filteredConversations(state, { agreement: 'both', from: '2026-11-04' }).length, 0);
  assert.equal(filteredConversations(state, { priority: 'P1' }).length, 1);
  assert.equal(filteredConversations(state, { variable: 'num_mensajes_cliente' }).length, 0);
  assert.equal(listQuerySchema.parse({ classification: 'positive', agreement: 'both' }).agreement, 'both');
});

test('un positivo refutado conserva respuesta y acuerdo originales pero no cuenta como vigente', () => {
  const { state, c } = fixture();
  const result = structuredClone(state.evaluations[0].results[2]);
  const body = { variableId: 'positive_event', evaluationId: 'evaluation', expectedReviewId: null, expectedVerdictId: null, action: 'refutar', reason: 'falta_contexto', comment: 'La felicitación corresponde a otra atención.' };
  recordReview(state, c.id, body, { id: 'reviewer', name: 'Supervisión' });
  const view = conversationView(state, c, undefined, true);
  assert.equal(view.positive, 0);
  assert.equal(view.dualDetected, false);
  const positive = view.variables.find(v => v.id === 'positive_event');
  assert.equal(positive.kind, 'refuted');
  assert.deepEqual(positive.result, result);
  assert.equal(positive.review.authorName, 'Supervisión');
  assert.equal(filteredConversations(state, { agreement: 'both' }).length, 0);
});

test('clasificación procede del snapshot histórico, no del catálogo vigente', () => {
  const { state, c } = fixture();
  state.catalog[0].mark = '';
  state.catalog[0].version = 2;
  state.catalog[0].retired = true;
  assert.equal(conversationView(state, c).critical, 1);
});

test('métricas no admiten revisión humana y una regla compartida no genera doble detección', () => {
  const { state, c } = fixture();
  state.evaluations[0].results[2].codeRule = 'shared-rule';
  assert.equal(conversationView(state, c).dualDetected, false);
  assert.throws(() => recordReview(state, c.id, { variableId: 'num_mensajes_cliente', evaluationId: 'evaluation', action: 'refutar' }, { id: 'u' }), /resultado revisable/);
});

test('una evaluación con cálculos válidos y flags fallidos no se presenta como ausencia de eventos', () => {
  const { state, c } = fixture();
  for (const r of state.evaluations[0].results.filter(r => ['critical_event', 'normal_event', 'positive_event'].includes(r.variableId))) {
    Object.assign(r, { status: 'no_evaluado', value: null, evidence: [], error: { code: 'INVALID_AI_RESULT' } });
    delete r.comparison;
  }
  const view = conversationView(state, c);
  assert.equal(view.evaluated, true);
  assert.equal(view.evaluationIncomplete, true);
  assert.equal(view.pendingFlags, 3);
  assert.equal(view.evaluationErrors, 3);
  assert.equal(view.marks.length, 0);
  assert.equal(view.dualDetected, false);
});

test('un lote no puede evaluar integraciones pendientes aunque se altere directamente la habilitación', async () => {
  for (const patch of [{ phase: 2, method: 'IA + código' }, { phase: 1, method: 'IA + código' }, { phase: 3, method: 'IA' }]) {
    const state = createState(false);
    const v = state.catalog.find(v => v.id === 'asistente_dijo_agotado_por_error');
    Object.assign(v, patch, { active: true });
    const store = { read: async () => structuredClone(state), transaction: async fn => fn(state) };
    let calls = 0;
    await assert.rejects(startEvaluationBatch(store, { configured: true, evaluate: async () => { calls++; } }), { code: 'UNSUPPORTED_VARIABLE' });
    assert.equal(calls, 0);
    assert.equal(state.jobs.length, 0);
  }
});
