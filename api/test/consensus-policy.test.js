import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { addV5Demo } from '../src/data/v5-demo.js';
import { conversationView, filteredConversations, recordReview, summarize, viewContext } from '../src/domain.js';
import { historicalProfileId } from '../src/evaluation-context.js';

const fixture = () => {
  const state = addV5Demo(createState(true));
  const c = state.conversations.find(c => c.id === 'DEMO-V5-01');
  const pair = state.evaluations.filter(e => e.conversationId === c.id);
  return { state, c, pair, variableId: 'cliente_molesto' };
};
const detail = (state, c) => conversationView(state, c, undefined, true);

test('solo el consenso equivalente publica flags; positivos, listas y mapa comparten la política', () => {
  const { state, c } = fixture();
  const before = JSON.stringify(state);
  const agreed = detail(state, c);
  assert.equal(agreed.critical, 1);
  assert.equal(agreed.normal, 0);
  assert.equal(agreed.positive, 2);
  assert.equal(agreed.marks.length, 3);
  assert.ok(agreed.marks.every(m => m.dualDetected));
  const disagreement = detail(state, state.conversations.find(c => c.id === 'DEMO-V5-02'));
  const flag = disagreement.variables.find(v => v.id === 'cliente_pidio_supervisor');
  assert.equal(flag.result.value, 1);
  assert.equal(flag.kind, null);
  assert.equal(flag.consensusSuppressed, true);
  assert.equal(flag.consensusPending, false);
  assert.equal(disagreement.suppressedFlags, 1);
  assert.equal(disagreement.critical, 0);
  assert.equal(disagreement.normal, 0);
  assert.equal(filteredConversations(state, { variable: 'cliente_pidio_supervisor' }).length, 0);
  assert.equal(filteredConversations(state, { classification: 'positive', country: 'HN' }).length, 1);
  assert.equal(summarize([agreed, disagreement]).withAlerts, 1);
  assert.equal(JSON.stringify(state), before);
});

test('legacy y resumen de comparación sin procedencia no crean consenso; vista por modelo conserva original', () => {
  const { state, c, pair, variableId } = fixture();
  state.jobs = [];
  pair[0].results.find(r => r.variableId === variableId).comparison = { agreement: 'agree-positive', detections: 2, votes: 2, cells: [] };
  const view = detail(state, c);
  assert.equal(view.marks.length, 0);
  const flag = view.variables.find(v => v.id === variableId);
  assert.equal(flag.consensusPending, true);
  assert.equal(flag.result.value, 1);
  assert.equal(flag.automaticFlagVisible, false);
  const raw = conversationView(state, c, viewContext(state, historicalProfileId(pair[0])), true);
  assert.equal(raw.critical, 1);
  assert.equal(raw.normal, 2); // Original shared calculations are not filtered in raw view.
  assert.equal(raw.positive, 2);
  assert.equal(raw.consensusPendingFlags, 0);
  assert.equal(raw.variables.find(v => v.id === variableId).automaticFlagVisible, true);
});

test('modelos duplicados, respuestas erróneas, abstenciones y versiones no equivalentes nunca publican consenso', () => {
  const mutations = [
    ({ pair }) => { pair[1].provider = pair[0].provider; pair[1].model = pair[0].model; },
    ({ pair, variableId }) => { pair[1].results.find(r => r.variableId === variableId).error = { code: 'INVALID_AI_RESULT' }; },
    ({ pair, variableId }) => { Object.assign(pair[1].results.find(r => r.variableId === variableId), { status: 'no_evaluado', value: null }); },
    ...['sourceHash', 'catalogHash', 'promptHash', 'rulesVersion'].map(key => ({ pair }) => { pair[1][key] = 'different'; }),
    ({ pair, variableId }) => { pair[1].catalogVersions = structuredClone(pair[1].catalogVersions); pair[1].catalogVersions.find(v => v.id === variableId).version++; },
    ({ pair, variableId }) => { pair[1].catalogVersions = structuredClone(pair[1].catalogVersions); pair[1].catalogVersions.find(v => v.id === variableId).active = false; },
    ({ pair }) => { pair[1].conversationId = 'other-conversation'; },
    ({ pair }) => { pair[1].taskId = pair[0].taskId; },
    ({ pair }) => { pair[1].profileId = pair[0].profileId; },
    ({ state }) => { state.jobs.find(j => j.id === 'demo-v5-dual').modelProfiles[1] = { ...state.jobs[0].modelProfiles[0] }; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    const flag = detail(f.state, f.c).variables.find(v => v.id === f.variableId);
    assert.equal(flag.kind, null);
    assert.equal(flag.automaticFlagVisible, false);
    assert.equal(flag.consensusPending, true);
  }
});

test('los nombres solicitados no reemplazan la identidad efectiva ausente al contar votos', () => {
  for (const missing of ['provider', 'model']) for (const value of [undefined, '', '   ']) {
    const { state, c, pair, variableId } = fixture();
    for (const e of pair) e[missing] = value;
    const flag = detail(state, c).variables.find(v => v.id === variableId);
    assert.equal(flag.result.value, 1);
    assert.equal(flag.kind, null);
    assert.equal(flag.automaticFlagVisible, false);
    assert.equal(flag.consensusPending, true);
    assert.equal(flag.result.comparison.votes, 0);
    assert.ok(flag.result.comparison.cells.every(cell => cell.identityVerified === false));
  }
});

test('código y reglas híbridas no se convierten en votos; las métricas permanecen disponibles', () => {
  for (const modification of [{ method: 'Código' }, { method: 'Cálculo' }, { method: 'IA + código', codeRule: 'shared-rule' }]) {
    const { state, c, pair, variableId } = fixture();
    for (const e of pair) Object.assign(e.results.find(r => r.variableId === variableId), modification);
    const view = detail(state, c), flag = view.variables.find(v => v.id === variableId);
    assert.equal(flag.kind, null);
    assert.equal(flag.consensusSuppressed, true);
    assert.equal(flag.consensusPending, false);
    assert.ok(view.metrics.some(v => v.result.status === 'evaluado'));
    assert.ok(view.metrics.every(v => !v.kind && !v.automaticFlagVisible && !v.consensusSuppressed));
  }
});

test('un positivo suprimido puede ser levantado por una persona con evidencia y deshacerse sin publicar el original', () => {
  const { state } = fixture();
  const c = state.conversations.find(c => c.id === 'DEMO-V5-02');
  const view = detail(state, c), variableId = 'cliente_pidio_supervisor';
  const before = JSON.stringify(state.evaluations);
  const body = { variableId, evaluationId: view.evaluation.id, expectedReviewId: null, action: 'levantar', reason: 'otro', comment: 'La persona confirma el evento y su evidencia.' };
  assert.throws(() => recordReview(state, c.id, { ...body, action: 'refutar' }, { id: 'u', name: 'Supervisión' }), /flag vigente/);
  assert.throws(() => recordReview(state, c.id, body, { id: 'u', name: 'Supervisión' }), /Selecciona un mensaje/);
  const review = recordReview(state, c.id, { ...body, messageId: c.messages[2].id }, { id: 'u', name: 'Supervisión' });
  const raised = detail(state, c);
  assert.equal(raised.variables.find(v => v.id === variableId).kind, 'human');
  assert.equal(raised.human, 1);
  assert.equal(raised.dualDetected, false);
  assert.equal(raised.suppressedFlags, 0);
  assert.equal(raised.variables.find(v => v.id === variableId).result.value, 1);
  recordReview(state, c.id, { ...body, action: 'deshacer', expectedReviewId: review.id, expectedVerdictId: review.id }, { id: 'u', name: 'Supervisión' });
  assert.equal(detail(state, c).variables.find(v => v.id === variableId).kind, null);
  assert.equal(JSON.stringify(state.evaluations), before);
});

test('dictamen presente aplica a una detección sin consenso y refutaciones históricas mantienen porcentajes coherentes', () => {
  const { state, c, pair, variableId } = fixture();
  pair[1].results.find(r => r.variableId === variableId).value = 0;
  state.verdicts.push({ id: 'human-verdict', conversationId: c.id, sourceHash: pair[0].sourceHash, variableId, catalogVersion: pair[0].catalogVersions.find(v => v.id === variableId).version,
    outcome: 'present', createdAt: '2026-11-05T00:00:00Z', authorName: 'Supervisión', comment: 'Dictamen con evidencia', evidence: { messageId: c.messages[0].id, quote: c.messages[0].text } });
  assert.equal(detail(state, c).variables.find(v => v.id === variableId).kind, 'human');
  const legacy = state.conversations.find(c => state.reviews.some(r => r.conversationId === c.id && r.action === 'refutar') && !c.id.startsWith('DEMO-V5'));
  const view = conversationView(state, legacy);
  assert.ok(view.refuted > 0);
  assert.ok(view.originalAlerts >= view.refuted);
  assert.ok(summarize([view]).refutedPercent <= 100);
});
