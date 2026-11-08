import test from 'node:test';
import assert from 'node:assert/strict';
import { cohortVisibilityAudit } from '../scripts/inspect-clef-cohort.js';
import { catalogV5 } from '../src/catalog-v5.js';
import { evaluateCodeVariables } from '../src/code-evaluator.js';
import { catalogReferences, evaluationContext } from '../src/evaluation-context.js';

function fixture() {
  const flag = structuredClone(catalogV5.find(v => v.type === 'Flag' && v.method === 'IA' && v.active));
  const code = structuredClone(catalogV5.find(v => v.id === 'primera_respuesta_humano_mayor_5_min'));
  const catalog = [flag, code];
  const conversation = { id: 'PRIVATE_CONVERSATION_ID', country: 'HN', date: '2026-11-05',
    agent: { id: 'synthetic' }, client: { name: 'PRIVATE_CLIENT_NAME' }, media: [],
    messages: [{ id: 'PRIVATE_MESSAGE_ID', actor: 'cliente', timestamp: '2026-11-05T12:00:00Z', text: 'PRIVATE_TRANSCRIPT' }] };
  const context = evaluationContext(conversation, catalog), refs = catalogReferences(catalog);
  const profiles = [{ id: 'gemma-local', provider: 'gateway', model: 'gemma-synthetic' },
    { id: 'clef-local', provider: 'gateway', model: 'clef-synthetic' }];
  const result = { variableId: flag.id, type: flag.type, method: flag.method, status: 'evaluado', value: 1,
    reason: 'PRIVATE_MODEL_REASON', evidence: [{ messageId: 'PRIVATE_MESSAGE_ID', quote: 'PRIVATE_EVIDENCE' }] };
  const evaluations = profiles.map((profile, i) => ({ id: `evaluation-${i}`, conversationId: conversation.id,
    jobId: i ? 'comparison' : 'original', taskId: `task-${i}`, purpose: i ? 'comparison' : 'operational',
    profileId: profile.id, model: profile.model, provider: profile.provider, ...context,
    catalogVersions: refs, partial: false, results: [structuredClone(result), ...evaluateCodeVariables(conversation, [code])] }));
  const manifest = { id: 'synthetic-maintenance', conversations: [{ id: conversation.id, activityDate: conversation.date }] };
  const sample = { id: 'comparison', jobId: 'comparison', cohortId: `clef-complement-${manifest.id}`,
    modelProfiles: profiles, catalogVersions: refs, cases: [{ conversationId: conversation.id, country: 'HN', ...context }] };
  const state = { catalog, catalogVersions: catalog.map(v => ({ id: `${v.id}:${v.version}`, itemId: v.id, version: v.version, snapshot: v })),
    conversations: [conversation], evaluations, operationalRefs: [{ id: conversation.id, evaluationId: evaluations[0].id }],
    jobs: [{ id: 'original', purpose: 'operational', mode: 'single', modelProfiles: [profiles[0]] },
      { id: sample.jobId, purpose: 'comparison', mode: 'single', modelProfiles: profiles }],
    tasks: profiles.map((profile, i) => ({ id: `task-${i}`, jobId: sample.jobId, conversationId: conversation.id,
      profile, evaluationId: evaluations[i].id, status: 'completed' })),
    comparisons: [sample], reviews: [], verdicts: [] };
  return { state, manifest, flag, code };
}

test('reports comparison agreement while preserving the separate single-model operational view', () => {
  const { state, manifest } = fixture(), before = structuredClone(state), beforeManifest = structuredClone(manifest);
  const report = cohortVisibilityAudit(state, manifest);
  assert.equal(report.comparison.bothDetected, 1);
  assert.equal(report.comparison.conversationsWithBothDetected, 1);
  assert.equal(report.operational.withAttentionFlags, 0);
  assert.equal(report.operational.withPositiveFlags, 0);
  assert.equal(report.operational.consensusPending, 1);
  assert.deepEqual(state, before);
  assert.deepEqual(manifest, beforeManifest);
});

test('distinguishes technical completion from unavailable calculation coverage', () => {
  const { state, manifest, code } = fixture();
  assert.ok(state.tasks.every(task => task.status === 'completed'));
  assert.ok(state.evaluations.every(evaluation => evaluation.partial === false));
  const report = cohortVisibilityAudit(state, manifest);
  assert.equal(report.operational.withResults, 1);
  assert.equal(report.operational.incomplete, 1);
  assert.equal(report.operational.withErrors, 0);
  assert.deepEqual(report.pendingByVariable, [{ variableId: code.id, method: 'Cálculo', unavailableInAdapter: true, noResult: 1, errors: 0 }]);
});

test('duplicate sample rows never inflate agreement or conversation counts', () => {
  const { state, manifest } = fixture();
  state.comparisons.push(structuredClone(state.comparisons[0]));
  const report = cohortVisibilityAudit(state, manifest);
  assert.equal(report.comparison.duplicateRows, 1);
  assert.equal(report.comparison.variablePairs, 1);
  assert.equal(report.comparison.bothDetected, 1);
  assert.equal(report.comparison.cases, 1);
  assert.equal(report.agreementsByVariable[0].count, 1);
});

test('incomplete results and changed content do not count as agreement', () => {
  const { state, manifest } = fixture();
  state.evaluations[1].results[0] = { ...state.evaluations[1].results[0], status: 'no_evaluado', value: null, evidence: [] };
  let report = cohortVisibilityAudit(state, manifest);
  assert.equal(report.comparison.incomplete, 1);
  assert.equal(report.comparison.bothDetected, 0);
  state.conversations[0].messages[0].text = 'CHANGED_PRIVATE_TRANSCRIPT';
  report = cohortVisibilityAudit(state, manifest);
  assert.equal(report.comparison.changedSourcePairs, 1);
  assert.equal(report.comparison.incomplete, 0);
  assert.equal(report.comparison.bothDetected, 0);
});

test('serialized report contains only aggregates and catalog identifiers', () => {
  const { state, manifest } = fixture();
  const output = JSON.stringify(cohortVisibilityAudit(state, manifest));
  for (const privateValue of ['PRIVATE_CONVERSATION_ID', 'PRIVATE_CLIENT_NAME', 'PRIVATE_MESSAGE_ID',
    'PRIVATE_TRANSCRIPT', 'PRIVATE_MODEL_REASON', 'PRIVATE_EVIDENCE']) assert.equal(output.includes(privateValue), false);
  for (const privateField of ['messages', 'clientName', 'evidence', 'quote', 'reason', 'evaluationId']) {
    assert.equal(output.includes(`"${privateField}":`), false);
  }
});
