import test from 'node:test';
import assert from 'node:assert/strict';
import { gemmaDetectionSummary } from '../src/gemma-detection-summary.js';

const maintenanceId = '77f134e8-fdf8-4154-b1f6-485c159b9194';
const context = { sourceHash: 'source', catalogHash: 'catalog', promptHash: 'prompt', rulesVersion: 'rules' };
function fixture() {
  const definitions = [
    { id: 'critical', name: 'Flag crítico guardado', mark: 'Crítico' }, { id: 'normal', name: 'Flag normal' },
    { id: 'positive', name: 'Flag positivo', mark: '+', polarity: 'positivo' },
    { id: 'hybrid', name: 'Híbrido', method: 'IA + código' }, { id: 'code', name: 'Regla compartida', method: 'Código' },
    { id: 'metric', name: 'Métrica', type: 'Métrica', method: 'Código' }, { id: 'descriptor', name: 'Descriptor', type: 'Descriptor' },
  ].map(item => ({ type: 'Flag', method: 'IA', version: 1, ...item }));
  const profile = { id: 'gemma-local', provider: 'gateway', model: 'gemma-synthetic', configurationHash: 'config' };
  const result = id => ({ variableId: id, status: 'evaluado', value: 1, reason: 'PRIVATE_REASON', evidence: [{ quote: 'PRIVATE_QUOTE' }] });
  const evaluation = { id: 'e1', conversationId: '1', taskId: 't1', jobId: 'j1', purpose: 'operational',
    profileId: profile.id, provider: profile.provider, model: profile.model, modelConfiguration: profile,
    partial: false, usedFallback: false, ...context,
    catalogVersions: definitions.map(d => ({ id: d.id, version: d.version, active: true })),
    results: ['critical', 'normal', 'positive', 'code', 'metric', 'descriptor'].map(result) };
  const state = { settings: { evaluationMaintenance: maintenanceId }, catalog: [{ ...definitions[0], version: 2, mark: '' }],
    catalogVersions: definitions.map(d => ({ id: `${d.id}:${d.version}`, itemId: d.id, version: d.version, snapshot: d })),
    evaluations: [evaluation], operationalRefs: [{ id: '1', evaluationId: 'e1' }],
    tasks: [{ id: 't1', conversationId: '1', jobId: 'j1', evaluationId: 'e1', status: 'completed', context, profile }],
    jobs: [{ id: 'j1', maintenanceId, purpose: 'operational' }] };
  return { state, evaluation, result };
}

test('counts only current equivalent Gemma references, using saved classifications and excluding metrics and descriptors', () => {
  const { state, evaluation } = fixture();
  state.evaluations.push({ ...structuredClone(evaluation), id: 'previous-attempt' });
  state.operationalRefs.push({ id: '1', evaluationId: 'e1' });
  const before = structuredClone(state), summary = gemmaDetectionSummary(state);
  assert.equal(summary.currentConversations, 1); assert.equal(summary.complete, 1); assert.equal(summary.partial, 0);
  assert.deepEqual(summary.detections, { critical: 1, normal: 1, positive: 1, total: 3 });
  assert.equal(summary.conversationsWithAnyGemmaFlag, 1);
  assert.deepEqual(summary.sharedCode.detections, { critical: 0, normal: 1, positive: 0, total: 1 });
  assert.equal(summary.topVariables.find(v => v.id === 'critical').name, 'Flag crítico guardado');
  assert.deepEqual(summary.topVariables[0].conversationIds, ['1']);
  assert.equal(summary.excluded.duplicateReferenceRows, 1);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_REASON|PRIVATE_QUOTE|sourceHash|configurationHash/);
  assert.deepEqual(state, before);
});

test('distinguishes original Gemma detections from rule-suppressed and code-produced effective results', () => {
  const { state, evaluation, result } = fixture();
  evaluation.results = [{ ...result('hybrid'), method: 'IA + código', value: 0,
    codeRule: 'synthetic-rule', aiResult: result('hybrid') }];
  let summary = gemmaDetectionSummary(state);
  assert.equal(summary.originalGemmaDetections.detections.total, 1);
  assert.equal(summary.effectiveGemmaDetections.detections.total, 0);
  assert.equal(summary.conversationsWithAnyGemmaFlag, 0);
  assert.equal(summary.suppressedBySharedRule, 1);
  evaluation.results[0].status = 'no_evaluado'; evaluation.results[0].value = null;
  assert.equal(gemmaDetectionSummary(state).suppressedBySharedRule, 1);
  evaluation.results[0].status = 'evaluado'; evaluation.results[0].value = 1;
  evaluation.results[0].aiResult.value = 0;
  summary = gemmaDetectionSummary(state);
  assert.equal(summary.originalGemmaDetections.detections.total, 0);
  assert.equal(summary.effectiveGemmaDetections.detections.total, 0);
  assert.equal(summary.sharedCode.detections.total, 1);
});

test('fails closed for other maintenance, providers, non-current tasks, changed context and missing saved definitions', () => {
  for (const mutate of [
    s => { s.jobs[0].maintenanceId = 'other'; }, s => { s.evaluations[0].provider = 'gemini'; },
    s => { s.evaluations[0].profileId = 'clef-local'; }, s => { s.tasks[0].evaluationId = 'old'; },
    s => { s.tasks[0].context = { ...context, sourceHash: 'changed' }; },
    s => { s.evaluations[0].modelConfiguration = { configurationHash: 'changed' }; },
    s => { s.evaluations[0].usedFallback = true; },
  ]) {
    const { state } = fixture(); mutate(state);
    const summary = gemmaDetectionSummary(state);
    assert.equal(summary.currentConversations, 0); assert.equal(summary.detections.total, 0);
  }
  const { state } = fixture(); state.catalogVersions = [];
  assert.equal(gemmaDetectionSummary(state).detections.total, 0, 'Current catalog cannot replace missing historical definitions');
  state.settings.evaluationMaintenance = null;
  assert.equal(gemmaDetectionSummary(state).available, false);
});

test('partial records retain valid flags but errors, abstentions, inactive references and duplicate variable rows never count', () => {
  const { state, evaluation, result } = fixture();
  evaluation.partial = true; state.tasks[0].status = 'partial';
  evaluation.results = [result('critical'), { ...result('normal'), error: { code: 'INVALID_AI_RESULT' } },
    { ...result('positive'), status: 'no_evaluado', value: null }, result('hybrid'), result('hybrid')];
  let summary = gemmaDetectionSummary(state);
  assert.equal(summary.complete, 0); assert.equal(summary.partial, 1);
  assert.deepEqual(summary.detections, { critical: 1, normal: 0, positive: 0, total: 1 });
  evaluation.catalogVersions.find(v => v.id === 'critical').active = false;
  assert.equal(gemmaDetectionSummary(state).detections.total, 0);
  state.operationalRefs.push({ id: '1', evaluationId: 'conflicting-reference' });
  summary = gemmaDetectionSummary(state);
  assert.equal(summary.currentConversations, 0); assert.equal(summary.excluded.ambiguousReferences, 1);
});
