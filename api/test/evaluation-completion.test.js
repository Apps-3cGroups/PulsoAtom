import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogV5 } from '../src/catalog-v5.js';
import { catalogReferences } from '../src/evaluation-context.js';
import { conversationView, viewContext } from '../src/domain.js';
import { dualizeEvaluation } from './fixtures/dual-state.js';

const FLAG = 'cliente_amenazo_cancelar_pedido';
const CODE = 'primera_respuesta_humano_mayor_5_min';
const DESCRIPTOR = 'tipo_interaccion';
const METRIC = 'num_mensajes_cliente';
const resultFor = (evaluation, variableId = FLAG) => evaluation.results.find(r => r.variableId === variableId);

function fixture() {
  const catalog = catalogV5.filter(v => [FLAG, CODE, DESCRIPTOR, METRIC].includes(v.id))
    .map(v => ({ ...structuredClone(v), active: true }));
  const conversation = { id: 'completion-synthetic', country: 'HN', date: '2026-11-05', completed: true,
    startedAt: '2026-11-05T15:00:00Z', endedAt: '2026-11-05T15:01:00Z',
    client: { name: 'Cliente sintético' }, agent: { id: 'synthetic-agent', name: 'Asesor sintético' }, topics: [], media: [],
    evaluationId: 'completion-result', messages: [{ id: 'synthetic-message', actor: 'cliente', text: 'Consulta sintética.', timestamp: '2026-11-05T15:00:00Z' }] };
  const evaluation = { id: conversation.evaluationId, conversationId: conversation.id, createdAt: '2026-11-06T15:00:00Z',
    partial: false, catalogVersions: catalogReferences(catalog), results: catalog.map(v => ({ variableId: v.id, type: v.type,
      method: v.method, status: v.id === CODE ? 'no_evaluado' : 'evaluado',
      value: v.id === CODE ? null : v.id === DESCRIPTOR ? 'consulta' : v.id === METRIC ? 1 : 0,
      reason: 'Resultado sintético', evidence: [],
      ...(v.id === CODE ? { codeRule: 'synthetic-business-hours', unavailableReason: 'BUSINESS_HOURS_NOT_CONFIGURED' } : {}) })) };
  const state = { conversations: [conversation], catalog,
    catalogVersions: catalog.map(v => ({ id: `${v.id}:${v.version}`, itemId: v.id, version: v.version, snapshot: v })),
    evaluations: [evaluation], jobs: [], tasks: [], comparisons: [], reviews: [], verdicts: [], operationalRefs: [] };
  const dual = dualizeEvaluation(state, conversation);
  return { state, conversation, ...dual };
}
const detail = f => conversationView(f.state, f.conversation, undefined, true);

test('both saved answers without events are evaluated even if a shared calculation is unavailable', () => {
  const f = fixture(), before = structuredClone(f.state), view = detail(f);
  assert.equal(view.evaluationStatus, 'evaluated');
  assert.equal(view.evaluated, true);
  assert.equal(view.evaluationIncomplete, false);
  assert.equal(view.evaluation.modelReviewPending, false);
  assert.equal(view.unavailableFlags, 1);
  assert.equal(view.pendingFlags, 1); // Legacy business-availability count is not execution status.
  assert.equal(view.evaluationErrors, 0);
  assert.deepEqual(view.marks, []);
  assert.ok(view.evaluation.modelReviews.every(r => r.status === 'completed'));
  assert.deepEqual(f.state, before);
});

test('valid abstentions are evaluated and unavailable flags exclude descriptors and metrics', () => {
  const f = fixture();
  for (const evaluation of [f.first, f.second]) for (const result of evaluation.results) {
    Object.assign(result, { status: 'no_evaluado', value: null, evidence: [], reason: 'Contexto insuficiente sintético' });
  }
  const view = detail(f);
  assert.equal(view.evaluationStatus, 'evaluated');
  assert.equal(view.evaluationIncomplete, false);
  assert.equal(view.evaluation.modelReviewPending, false);
  assert.equal(view.unavailableFlags, 2);
  assert.equal(view.evaluationErrors, 0);
  assert.equal(view.consensusPendingFlags, 1);
  assert.deepEqual(view.marks, []);
  assert.ok(view.evaluation.modelReviews.every(r => r.status === 'completed' && r.abstainedCount === 2 && r.errorCount === 0));
});

test('disagreement is a completed review and a conclusive saved detection is not made unavailable', () => {
  const f = fixture();
  resultFor(f.first).value = 1;
  const view = detail(f);
  assert.equal(view.evaluationStatus, 'evaluated');
  assert.equal(view.evaluationIncomplete, false);
  assert.equal(view.unavailableFlags, 1);
  assert.equal(view.suppressedFlags, 1);
  assert.equal(view.variables.find(v => v.id === FLAG).result.comparison.agreement, 'disagree');
  assert.deepEqual(view.marks, []);
});

test('a dual operational review retains historical answers but stops publishing flags when Atom changes', () => {
  const f = fixture();
  resultFor(f.first).value = resultFor(f.second).value = 1;
  assert.equal(detail(f).marks.length, 1);
  f.conversation.messages[0].text += ' Contenido posterior a las evaluaciones.';
  const view = detail(f);
  assert.equal(view.sourceChanged, true);
  assert.equal(view.evaluationStatus, 'evaluated');
  assert.equal(view.evaluation.modelReviews.length, 2);
  const comparison = view.variables.find(v => v.id === FLAG).result.comparison;
  assert.equal(comparison.agreement, 'agree-positive');
  assert.equal(comparison.sourceChanged, true);
  assert.equal(comparison.cells.filter(c => c.result).length, 2);
  assert.deepEqual(view.marks, []);
});

test('only a missing, queued or running second answer keeps the review pending', () => {
  for (const status of ['pending', 'running', 'missing']) {
    const f = fixture();
    const task = f.state.tasks.find(t => t.evaluationId === f.second.id);
    if (status === 'missing') f.state.tasks = f.state.tasks.filter(t => t !== task);
    else { task.status = status; task.evaluationId = null; }
    const view = detail(f);
    assert.equal(view.evaluationStatus, 'review_pending', status);
    assert.equal(view.evaluation.modelReviewPending, true, status);
    assert.equal(view.evaluationIncomplete, true, status);
    assert.equal(view.evaluation.modelReviews[1].status, status === 'missing' ? 'pending' : status);
  }
});

test('a terminal failed model is evaluated with an incident rather than still running', () => {
  const f = fixture(), task = f.state.tasks.find(t => t.evaluationId === f.second.id);
  Object.assign(task, { status: 'failed', evaluationId: null, error: { code: 'AI_TRANSIENT', message: 'Synthetic private failure' } });
  const view = detail(f);
  assert.equal(view.evaluationStatus, 'partial');
  assert.equal(view.evaluated, true);
  assert.equal(view.evaluationIncomplete, true);
  assert.equal(view.evaluation.modelReviewPending, false);
  assert.equal(view.evaluation.modelReviews[1].status, 'failed');
  assert.equal(view.evaluationErrors, 1);
  assert.equal(JSON.stringify(view).includes('Synthetic private failure'), false);
});

test('an existing technical incident does not conceal that the other model is still running', () => {
  const f = fixture();
  f.first.partial = true;
  f.state.tasks.find(t => t.evaluationId === f.first.id).status = 'partial';
  Object.assign(resultFor(f.first), { status: 'no_evaluado', value: null,
    error: { code: 'INVALID_AI_RESULT', message: 'Synthetic first-model error' } });
  Object.assign(f.state.tasks.find(t => t.evaluationId === f.second.id), { status: 'running', evaluationId: null });
  const view = detail(f);
  assert.equal(view.evaluationStatus, 'review_pending');
  assert.equal(view.evaluation.modelReviewPending, true);
  assert.equal(view.evaluationErrors, 1);
  assert.equal(view.evaluation.modelReviews[0].status, 'partial');
  assert.equal(view.evaluation.modelReviews[1].status, 'running');
});

test('a descriptor error in the second model remains a technical incident even when the first descriptor is valid', () => {
  const f = fixture();
  const task = f.state.tasks.find(t => t.evaluationId === f.second.id);
  task.status = 'partial'; f.second.partial = true;
  Object.assign(resultFor(f.second, DESCRIPTOR), { status: 'no_evaluado', value: null,
    error: { code: 'INVALID_AI_RESULT', message: 'Synthetic private invalid descriptor' } });
  const view = detail(f);
  assert.equal(view.descriptors[0].result.status, 'evaluado');
  assert.equal(view.evaluationStatus, 'partial');
  assert.equal(view.evaluation.modelReviewPending, false);
  assert.equal(view.evaluation.modelReviews[1].errorCount, 1);
  assert.equal(view.evaluation.modelReviews[1].status, 'partial');
  assert.equal(view.unavailableFlags, 1);
  assert.equal(JSON.stringify(view).includes('Synthetic private invalid descriptor'), false);
});

test('a flag response error is not treated as a valid abstention', () => {
  const f = fixture();
  Object.assign(resultFor(f.second), { status: 'no_evaluado', value: null,
    error: { code: 'INVALID_AI_RESULT', message: 'Synthetic invalid flag' } });
  const view = detail(f);
  assert.equal(view.evaluationStatus, 'partial');
  assert.equal(view.evaluation.modelReviewPending, false);
  assert.equal(view.evaluationErrors, 1);
  assert.equal(view.unavailableFlags, 1);
  assert.equal(view.evaluation.modelReviews[1].abstainedCount, 0);
});

test('the raw single-model view does not require a second model for completion', () => {
  const f = fixture();
  Object.assign(resultFor(f.first), { status: 'no_evaluado', value: null });
  const view = conversationView(f.state, f.conversation, viewContext(f.state, f.profiles[0].id), true);
  assert.equal(view.rawModelView, true);
  assert.equal(view.evaluationStatus, 'evaluated');
  assert.equal(view.evaluationIncomplete, false);
  assert.equal(view.unavailableFlags, 2);
});

test('a conversation without any saved evaluation is not evaluated and has no model abstentions', () => {
  const f = fixture();
  f.state.evaluations = []; f.state.jobs = []; f.state.tasks = [];
  delete f.conversation.evaluationId;
  const view = detail(f);
  assert.equal(view.evaluationStatus, 'not_evaluated');
  assert.equal(view.evaluated, false);
  assert.equal(view.evaluationIncomplete, false);
  assert.equal(view.evaluation, null);
  assert.equal(view.unavailableFlags, 0);
});
