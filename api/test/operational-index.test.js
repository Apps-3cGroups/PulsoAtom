import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { catalogV5 } from '../src/catalog-v5.js';
import { catalogReferences, digest, evaluationSelectionContext, selectedEvaluation, selectedStoredEvaluation, historicalProfileId } from '../src/evaluation-context.js';
import { operationalEvaluation, operationalConsensus, hasCompleteLocalModelPair, hasVerifiedHistoricalModelPair } from '../src/operational-evaluation.js';
import { operationalReadIndex } from '../src/operational-index.js';
import { dualizeEvaluation } from './fixtures/dual-state.js';

const flag = 'cliente_amenazo_cancelar_pedido';
function fixture() {
  const state = createState(false);
  state.catalog = catalogV5.filter(v => v.id === flag).map(v => ({ ...structuredClone(v), active: true }));
  state.catalogVersions = state.catalog.map(v => ({ id: `${v.id}:${v.version}`, itemId: v.id, version: v.version, snapshot: v }));
  const conversation = { id: 'synthetic-index', country: 'HN', completed: true, evaluationId: 'synthetic-anchor',
    messages: [{ id: 'message', actor: 'cliente', text: 'Synthetic cancellation.', timestamp: '2026-11-18T12:00:00Z' }] };
  state.conversations = [conversation];
  state.evaluations = [{ id: conversation.evaluationId, conversationId: conversation.id, createdAt: '2026-11-19T12:00:00Z',
    catalogVersions: catalogReferences(state.catalog), results: [{ variableId: flag, method: 'IA', type: 'Flag', status: 'evaluado', value: 1, evidence: [] }] }];
  const pair = dualizeEvaluation(state, conversation);
  pair.profiles.forEach((profile, i) => {
    Object.assign(profile, { id: i ? 'gemma-local' : 'clef-local', provider: 'gateway', model: i ? 'synthetic-gemma' : 'synthetic-clef' });
    profile.configurationHash = digest(profile);
    Object.assign(i ? pair.second : pair.first, { profileId: profile.id, requestedProfileId: profile.id,
      model: profile.model, provider: profile.provider, modelConfiguration: structuredClone(profile) });
  });
  conversation.messages[0].text += ' Source updated.';
  return { state, conversation, ...pair, job: state.jobs[0], secondTask: state.tasks.find(t => t.evaluationId === pair.second.id) };
}
function parity(f, index = operationalReadIndex(f.state)) {
  const before = structuredClone(f.state), old = operationalEvaluation(f.state, f.first), indexed = operationalEvaluation(f.state, f.first, index);
  assert.deepEqual(indexed, old);
  assert.equal(hasCompleteLocalModelPair(indexed), hasCompleteLocalModelPair(old));
  assert.equal(hasVerifiedHistoricalModelPair(indexed), hasVerifiedHistoricalModelPair(old));
  for (const result of old.results) assert.deepEqual(operationalConsensus(indexed, result.variableId), operationalConsensus(old, result.variableId));
  assert.deepEqual(f.state, before);
  return indexed;
}

test('indexed reads preserve dual, partial, foreign-contract and duplicate-record semantics exactly', () => {
  const mutations = [
    () => {}, f => { f.job.mode = 'single'; }, f => { f.secondTask.status = 'pending'; },
    f => { f.secondTask.evaluationId = null; }, f => { f.second.sourceHash = 'foreign'; },
    f => { f.second.modelConfiguration.configurationHash = 'foreign'; },
    f => { f.second.results[0].value = 0; }, f => { f.second.results[0].status = 'no_evaluado'; f.second.results[0].value = null; },
    f => { f.state.evaluations.push(structuredClone(f.second)); },
    f => { f.state.tasks.push({ ...structuredClone(f.secondTask), id: 'duplicate-task' }); },
    f => { f.state.conversations.push(structuredClone(f.conversation)); },
    f => { f.state.jobs.push({ ...structuredClone(f.job), mode: 'single' }); },
    f => { f.state.jobs.unshift({ ...structuredClone(f.job), mode: 'single' }); },
    f => { f.state.catalogVersions.unshift({ ...structuredClone(f.state.catalogVersions[0]), snapshot: { ...f.state.catalogVersions[0].snapshot, method: 'Código' } }); },
    f => { f.state.evaluations.unshift({ ...structuredClone(f.second), sourceHash: 'foreign' }); },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); parity(f); }
});

test('indexed projection never scans global history arrays after index construction', () => {
  const f = fixture(), expected = operationalEvaluation(f.state, f.first), index = operationalReadIndex(f.state);
  for (const collection of ['jobs', 'tasks', 'evaluations', 'conversations', 'comparisons', 'catalogVersions']) {
    Object.defineProperty(f.state, collection, { get() { throw new Error(`Unexpected global scan: ${collection}`); } });
  }
  assert.deepEqual(operationalEvaluation(f.state, f.first, index), expected);
});

test('selection creates one lazy index per read, leaves exposure/raw lookup untouched and refreshes after mutation', () => {
  const f = fixture(), context = evaluationSelectionContext(f.state);
  selectedStoredEvaluation(f.state, f.conversation, undefined, context);
  selectedEvaluation(f.state, f.conversation, historicalProfileId(f.second), context);
  assert.equal(context.operationalIndex, undefined);
  selectedEvaluation(f.state, f.conversation, undefined, context);
  const index = context.operationalIndex;
  assert.ok(index);
  selectedEvaluation(f.state, f.conversation, undefined, context);
  assert.equal(context.operationalIndex, index);
  const replacement = { ...structuredClone(f.second), id: 'replacement', results: [{ ...f.second.results[0], value: 0 }] };
  f.state.evaluations.push(replacement); f.secondTask.evaluationId = replacement.id;
  const next = evaluationSelectionContext(f.state);
  assert.deepEqual(selectedEvaluation(f.state, f.conversation, undefined, next), selectedEvaluation(f.state, f.conversation));
  assert.notEqual(next.operationalIndex, index);
});

test('an index for a different state cannot change another snapshot or mutable calls', () => {
  const f = fixture(), foreign = fixture(); foreign.secondTask.status = 'failed';
  parity(f, operationalReadIndex(foreign.state));
  f.secondTask.status = 'pending';
  assert.equal(operationalEvaluation(f.state, f.first).modelReviewPending, true);
});
