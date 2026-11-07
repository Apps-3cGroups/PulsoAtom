import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { catalogReferences, evaluationContext } from '../src/evaluation-context.js';
import { resumeEvaluationBatch } from '../src/evaluation-service.js';

const maintenanceId = 'synthetic-clef-maintenance';
function fixture() {
  const state = createState(false), calls = [], reads = [];
  state.catalog = state.catalog.filter(v => v.active && !v.retired && v.type === 'Flag' && v.method === 'IA').slice(0, 2);
  state.catalogVersions = state.catalog.map(v => ({ itemId: v.id, version: v.version, snapshot: structuredClone(v) }));
  state.settings.evaluationMaintenance = maintenanceId;
  state.settings.dailyEnabled = false;
  state.settings.aiPolicy = { mode: 'single', primaryId: 'gemma-local', fallbackId: null, version: 6 };
  state.conversations = ['c1', 'c2'].map(id => ({ id, country: 'HN', date: '2026-11-07', completed: true,
    client: { name: 'Cliente sintético' }, messages: [{ id: `${id}-m1`, actor: 'cliente', text: 'Consulta sintética.', timestamp: '2026-11-07T15:00:00Z' }] }));
  const registry = new ModelRegistry(['gemma-local', 'clef-local'].map(id => ({ id, label: id, provider: 'gateway', model: `${id}-synthetic`, enabled: true,
    evaluator: { configured: true, baseUrl: 'http://gateway.synthetic', toolKey: 'gemma', portalKey: 'portal-pulso',
      async evaluate(conversation, variables) {
        calls.push([id, conversation.id]);
        return { model: `${id}-synthetic`, results: variables.map(v => ({ variableId: v.id, type: v.type, method: v.method,
          status: 'evaluado', value: 0, reason: 'No se observa el evento en el texto sintético.', evidence: [] })) };
      } },
  })));
  const profiles = registry.list().map(({ configured, available, enabled, ...snapshot }) => snapshot);
  const job = { id: 'synthetic-complement', purpose: 'comparison', mode: 'single', status: 'interrupted',
    maintenanceId, modelProfiles: profiles, conversationIds: ['c1', 'c2'], catalogVersions: catalogReferences(state.catalog),
    createdAt: '2026-11-07T16:00:00Z', total: 4, caseCount: 2, concurrency: 1, completed: 0, failed: 2 };
  state.jobs = [job];
  state.tasks = state.conversations.flatMap(conversation => profiles.map(profile => ({ id: `${conversation.id}-${profile.id}`,
    jobId: job.id, conversationId: conversation.id, profile, fallback: null, codeResults: [], context: evaluationContext(conversation, state.catalog),
    status: profile.id === 'gemma-local' ? 'partial' : 'pending', round: 1,
    evaluationId: profile.id === 'gemma-local' ? `original-${conversation.id}` : null,
    error: profile.id === 'gemma-local' ? { code: 'INVALID_AI_RESULT', message: 'Resultado Gemma parcial conservado.' } : null })));
  state.evaluations = state.conversations.map(c => ({ id: `original-${c.id}`, conversationId: c.id, profileId: 'gemma-local',
    purpose: 'operational', partial: true, results: [{ variableId: state.catalog[0].id, status: 'no_evaluado', value: null, reason: 'Conservar original.' }] }));
  state.operationalRefs = state.conversations.map(c => ({ id: c.id, evaluationId: `original-${c.id}` }));
  const store = {
    async read() { return structuredClone(state); },
    async readWithConversations(options) {
      reads.push(structuredClone(options));
      return { ...structuredClone(state), conversations: structuredClone(state.conversations.filter(c => options.conversationIds.includes(c.id))) };
    },
    async transaction(fn) { const draft = structuredClone(state), result = await fn(draft); Object.assign(state, draft); return structuredClone(result); },
  };
  return { state, store, registry, job, calls, reads };
}

test('profile-scoped resume never resolves or retries retained partial Gemma and preserves its history', async () => {
  const f = fixture();
  f.registry.profiles.find(p => p.id === 'gemma-local').enabled = false;
  for (const task of f.state.tasks.filter(t => t.profile.id === 'gemma-local')) task.context.sourceHash = 'historical-context-not-to-recheck';
  const gemmaTasks = structuredClone(f.state.tasks.filter(t => t.profile.id === 'gemma-local'));
  const evaluations = structuredClone(f.state.evaluations), refs = structuredClone(f.state.operationalRefs), settings = structuredClone(f.state.settings);
  const resumed = await resumeEvaluationBatch(f.store, f.registry, f.job.id, { profileIds: ['clef-local'] });
  const finished = await resumed.completion;
  assert.deepEqual(f.calls, [['clef-local', 'c1'], ['clef-local', 'c2']]);
  assert.deepEqual(f.state.tasks.filter(t => t.profile.id === 'gemma-local'), gemmaTasks);
  assert.deepEqual(f.state.evaluations.filter(e => e.profileId === 'gemma-local'), evaluations);
  assert.deepEqual(f.state.operationalRefs, refs);
  assert.deepEqual(f.state.settings, settings);
  assert.equal(finished.status, 'partial');
  assert.equal(finished.partial, 2);
  assert.equal(f.state.attempts.length, 2);
  assert.ok(f.state.attempts.every(a => a.profileId === 'clef-local'));
  assert.deepEqual(f.reads[0].conversationIds, ['c1', 'c2']);
});

test('conversation and profile scopes intersect and untouched cases do not get read or retried', async () => {
  const f = fixture(), before = structuredClone(f.state.tasks.filter(t => t.id !== 'c2-clef-local'));
  f.state.conversations[0].messages[0].text = 'Changed source outside selected case.';
  const resumed = await resumeEvaluationBatch(f.store, f.registry, f.job.id, { conversationIds: ['c2'], profileIds: ['clef-local'] });
  assert.equal((await resumed.completion).status, 'interrupted');
  assert.deepEqual(f.calls, [['clef-local', 'c2']]);
  assert.ok(f.reads.every(read => read.conversationIds.length === 1 && read.conversationIds[0] === 'c2'));
  assert.deepEqual(f.state.tasks.filter(t => t.id !== 'c2-clef-local'), before);
});

test('profile scopes require unique known profiles and an exact active maintenance before source reads', async () => {
  for (const profileIds of [[], null, 'clef-local', ['clef-local', 'clef-local'], ['unknown'], ['clef-local', 1]]) {
    const f = fixture();
    await assert.rejects(resumeEvaluationBatch(f.store, f.registry, f.job.id, { profileIds }), { code: 'INVALID_RECHECK' });
    assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0);
  }
  for (const maintenance of [undefined, null, 'another-maintenance']) {
    const f = fixture(); f.state.settings.evaluationMaintenance = maintenance;
    await assert.rejects(resumeEvaluationBatch(f.store, f.registry, f.job.id, { profileIds: ['clef-local'] }), { code: 'EVALUATION_MAINTENANCE' });
    assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); delete f.job.maintenanceId;
  await assert.rejects(resumeEvaluationBatch(f.store, f.registry, f.job.id, { profileIds: ['clef-local'] }), { code: 'EVALUATION_MAINTENANCE' });
});

test('a completed selected profile cannot fall through to another pending model', async () => {
  const f = fixture();
  for (const task of f.state.tasks.filter(t => t.profile.id === 'clef-local')) task.status = 'completed';
  await assert.rejects(resumeEvaluationBatch(f.store, f.registry, f.job.id, { profileIds: ['clef-local'] }), { code: 'ALREADY_COMPLETED' });
  assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0);
});

test('profile scope rejects a fallback outside the selected models and source changes inside the scope', async () => {
  const fallback = fixture();
  fallback.state.tasks.find(t => t.id === 'c1-clef-local').fallback = fallback.job.modelProfiles[0];
  await assert.rejects(resumeEvaluationBatch(fallback.store, fallback.registry, fallback.job.id, { profileIds: ['clef-local'] }), { code: 'INVALID_RECHECK' });
  assert.equal(fallback.calls.length, 0);
  const changed = fixture(); changed.state.conversations[0].messages[0].text = 'Changed selected source.';
  await assert.rejects(resumeEvaluationBatch(changed.store, changed.registry, changed.job.id, { profileIds: ['clef-local'] }), { code: 'SOURCE_CHANGED' });
  assert.equal(changed.calls.length, 0);
});

test('maintenance is rechecked under the transaction lock before any model request', async () => {
  const f = fixture(), originalTransaction = f.store.transaction;
  f.store.transaction = async fn => { f.state.settings.evaluationMaintenance = null; return originalTransaction(fn); };
  await assert.rejects(resumeEvaluationBatch(f.store, f.registry, f.job.id, { profileIds: ['clef-local'] }), { code: 'EVALUATION_MAINTENANCE' });
  assert.equal(f.calls.length, 0);
  assert.ok(f.state.tasks.every(t => t.round === 1));
});

test('omitting profileIds retains the existing behavior of resuming all unfinished model tasks', async () => {
  const f = fixture();
  const resumed = await resumeEvaluationBatch(f.store, f.registry, f.job.id);
  assert.equal((await resumed.completion).status, 'completed');
  assert.deepEqual(f.calls, [['gemma-local', 'c1'], ['clef-local', 'c1'], ['gemma-local', 'c2'], ['clef-local', 'c2']]);
});
