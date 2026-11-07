import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { catalogReferences, evaluationContext } from '../src/evaluation-context.js';
import { createGemmaBackfillPlan } from '../src/gemma-backfill.js';
import { createClefCohortBatch } from '../src/clef-cohort.js';
import { comparisonRows } from '../src/comparisons.js';
import { resumeEvaluationBatch } from '../src/evaluation-service.js';

const maintenanceId = '77f134e8-fdf8-4154-b1f6-485c159b9194';
function fixture() {
  const state = createState(false), calls = [];
  state.catalog = state.catalog.filter(v => v.active && !v.retired && v.type === 'Flag' && v.method === 'IA').slice(0, 2);
  state.catalogVersions = state.catalog.map(v => ({ itemId: v.id, version: v.version, snapshot: structuredClone(v) }));
  state.settings = { ...state.settings, dailyEnabled: false, evaluationMaintenance: maintenanceId,
    aiPolicy: { mode: 'single', primaryId: 'gemma-local', secondaryId: null, fallbackId: null, version: 6 } };
  state.conversations = Array.from({ length: 500 }, (_, i) => ({ id: String(i + 1), country: 'HN', date: '2026-11-06', completed: true,
    client: { name: 'PRIVATE_CLIENT_NOT_COPIED' },
    messages: [{ id: `m-${i + 1}`, actor: 'cliente', text: 'PRIVATE_TRANSCRIPT_NOT_COPIED', timestamp: '2026-11-06T15:00:00Z' }] }));
  const registry = new ModelRegistry(['gemma-local', 'clef-local'].map((id, i) => ({ id, provider: 'gateway', label: i ? 'Clef' : 'Gemma',
    model: i ? 'clef-flash' : 'gemma-synthetic', enabled: true,
    evaluator: { configured: true, baseUrl: 'http://gateway.synthetic', toolKey: 'gemma', portalKey: 'portal-pulso', timeoutMs: 180000,
      ...(i ? { decisionInstructionsVersion: 'clef-flash-decisions-1' } : {}),
      async evaluate(conversation, variables) {
        assert.equal(id, 'clef-local', 'Gemma must never be inferred again'); calls.push(conversation.id);
        return { model: 'clef-flash', decisionInstructionsVersion: 'clef-flash-decisions-1', results: variables.map(v => ({
          variableId: v.id, type: v.type, method: v.method, status: 'evaluado', value: 0, reason: 'Resultado sintético.', evidence: [] })) };
      } },
  })));
  const manifest = createGemmaBackfillPlan(state, registry, { maintenanceId, createdAt: '2026-11-06T16:00:00Z' });
  const gemma = manifest.profile, clef = registry.snapshot(registry.resolve('clef-local'));
  const originalJob = { id: 'original-gemma-job', purpose: 'operational', mode: 'single', maintenanceId,
    status: 'partial', conversationIds: manifest.conversations.map(c => c.id), modelProfiles: [structuredClone(gemma)],
    createdAt: manifest.createdAt, catalogVersions: catalogReferences(state.catalog) };
  state.jobs = [originalJob]; state.tasks = []; state.evaluations = []; state.operationalRefs = [];
  for (const source of state.conversations) {
    const partial = Number(source.id) % 2 === 0;
    const context = evaluationContext(source, state.catalog), taskId = `gemma-task-${source.id}`, evaluationId = `gemma-evaluation-${source.id}`;
    const error = partial ? { code: 'INVALID_AI_RESULT', message: 'Variable pendiente de formato.' } : null;
    const results = state.catalog.map((v, i) => ({ variableId: v.id, type: v.type, method: v.method,
      status: partial && i ? 'no_evaluado' : 'evaluado', value: partial && i ? null : 0,
      reason: partial && i ? 'Pendiente de respuesta válida.' : 'Resultado original sintético.', evidence: [], ...(partial && i ? { error } : {}) }));
    state.tasks.push({ id: taskId, jobId: originalJob.id, conversationId: source.id, profile: structuredClone(gemma),
      context, codeResults: [], status: partial ? 'partial' : 'completed', round: partial ? 3 : 1, evaluationId, error });
    state.evaluations.push({ id: evaluationId, taskId, jobId: originalJob.id, conversationId: source.id, purpose: 'operational',
      profileId: 'gemma-local', requestedProfileId: 'gemma-local', model: gemma.model, provider: 'gateway',
      modelConfiguration: structuredClone(gemma), partial, usedFallback: false, ...context,
      catalogVersions: catalogReferences(state.catalog), results, createdAt: '2026-11-06T17:00:00Z' });
    state.operationalRefs.push({ id: source.id, evaluationId });
  }
  const ids = manifest.conversations.slice(0, 20).map(c => c.id);
  const store = {
    async read() { return structuredClone(state); },
    async readWithConversations({ conversationIds }) { return { ...structuredClone(state), conversations: structuredClone(state.conversations.filter(c => conversationIds.includes(c.id))) }; },
    async transaction(fn) { const draft = structuredClone(state), value = await fn(draft); Object.assign(state, draft); return structuredClone(value); },
  };
  return { state, manifest, registry, clef, ids, calls, store };
}

test('prepares additive twenty-case comparison with exact Gemma references, partial states and no transcript copies', () => {
  const f = fixture(), before = structuredClone(f.state), originalManifest = structuredClone(f.manifest);
  const batch = createClefCohortBatch(f.state, f.manifest, f.clef, f.ids, 0);
  assert.deepEqual(f.state, before); assert.deepEqual(f.manifest, originalManifest); assert.deepEqual(f.calls, []);
  assert.equal(batch.job.purpose, 'comparison'); assert.equal(batch.job.mode, 'single'); assert.equal(batch.job.concurrency, 1);
  assert.equal(batch.job.cohortId, `clef-complement-${maintenanceId}`);
  assert.equal(batch.job.idempotencyKey, `clef-complement-${maintenanceId}:0`);
  assert.equal(batch.job.maintenanceId, maintenanceId); assert.equal(batch.job.fallback, null);
  assert.equal(batch.job.total, 40); assert.equal(batch.job.caseCount, 20); assert.equal(batch.job.partial, 10);
  assert.equal(batch.job.reusedTaskCount, 20); assert.equal(batch.job.newTaskCount, 20);
  assert.deepEqual(batch.job.modelProfiles, [f.manifest.profile, f.clef]);
  assert.equal(new Set(batch.tasks.map(t => t.id)).size, 40);
  for (const task of batch.tasks) {
    assert.equal(task.jobId, batch.job.id); assert.equal(task.fallback, null);
    if (task.profile.id === 'clef-local') {
      assert.equal(task.status, 'pending'); assert.equal(task.round, 0); assert.equal(task.evaluationId, null);
    } else {
      const original = f.state.tasks.find(t => t.id === task.reusedTaskId);
      assert.equal(task.evaluationId, original.evaluationId); assert.equal(task.status, original.status);
      assert.equal(task.reusedJobId, original.jobId); assert.notEqual(task.id, original.id);
      assert.deepEqual(task.context, original.context); assert.deepEqual(task.codeResults, original.codeResults);
    }
  }
  assert.deepEqual(batch.sample.cases.map(c => c.date), f.manifest.conversations.slice(0, 20).map(c => c.activityDate));
  assert.doesNotMatch(JSON.stringify(batch), /PRIVATE_TRANSCRIPT_NOT_COPIED|PRIVATE_CLIENT_NOT_COPIED|"messages"/);
});

test('a changed source, replaced Gemma anchor, mismatched profile or catalog cannot join the cohort', () => {
  for (const change of [
    f => { f.state.conversations.find(c => c.id === f.ids[0]).messages[0].text = 'changed'; },
    f => { f.state.operationalRefs.find(r => r.id === f.ids[0]).evaluationId = 'another-evaluation'; },
    f => { f.state.evaluations.find(e => e.conversationId === f.ids[0]).modelConfiguration.configurationHash = 'b'.repeat(64); },
    f => { f.state.tasks.find(t => t.conversationId === f.ids[0]).context.sourceHash = 'b'.repeat(64); },
    f => { f.state.catalog[0].version++; },
    f => { f.clef.model = 'other-model'; },
    f => { f.state.settings.evaluationMaintenance = 'other-maintenance'; },
    f => { f.state.settings.dailyEnabled = true; },
    f => { f.manifest.conversations[0].sourceHash = 'b'.repeat(64); },
  ]) {
    const f = fixture(); change(f); const before = structuredClone(f.state);
    assert.throws(() => createClefCohortBatch(f.state, f.manifest, f.clef, f.ids, 0));
    assert.deepEqual(f.state, before); assert.deepEqual(f.calls, []);
  }
});

test('rejects invalid batches and overlapping reservations with a deterministic idempotency key', () => {
  const f = fixture();
  for (const ids of [[], [f.ids[0], f.ids[0]], ['not-in-manifest'], f.manifest.conversations.slice(0, 21).map(c => c.id)]) {
    assert.throws(() => createClefCohortBatch(f.state, f.manifest, f.clef, ids, 0), { code: 'INVALID_CLEF_COHORT_BATCH' });
  }
  for (const index of [-1, 0.5, '0']) assert.throws(() => createClefCohortBatch(f.state, f.manifest, f.clef, f.ids, index), { code: 'INVALID_CLEF_COHORT_BATCH' });
  const first = createClefCohortBatch(f.state, f.manifest, f.clef, f.ids, 0);
  const again = createClefCohortBatch(f.state, f.manifest, f.clef, f.ids, 0);
  assert.equal(first.job.idempotencyKey, again.job.idempotencyKey); assert.equal(first.job.requestHash, again.job.requestHash);
  f.state.jobs.push(first.job);
  assert.throws(() => createClefCohortBatch(f.state, f.manifest, f.clef, f.ids, 0), { code: 'DUPLICATE_EXECUTION' });
  assert.throws(() => createClefCohortBatch(f.state, f.manifest, f.clef, [f.ids[0]], 1), { code: 'DUPLICATE_EXECUTION' });
});

test('the existing comparison engine reuses historical Gemma and runs only Clef while preserving operational references', async () => {
  const f = fixture(), originalEvaluations = structuredClone(f.state.evaluations), originalTasks = structuredClone(f.state.tasks), refs = structuredClone(f.state.operationalRefs);
  const ids = f.ids.slice(0, 2), batch = createClefCohortBatch(f.state, f.manifest, f.clef, ids, 0);
  f.state.jobs.push(batch.job); f.state.tasks.push(...batch.tasks); f.state.comparisons.push(batch.sample);
  const resumed = await resumeEvaluationBatch(f.store, f.registry, batch.job.id, { profileIds: ['clef-local'] });
  assert.equal((await resumed.completion).status, 'partial');
  assert.deepEqual(f.calls, ids);
  assert.deepEqual(f.state.operationalRefs, refs);
  assert.deepEqual(f.state.evaluations.filter(e => e.profileId === 'gemma-local'), originalEvaluations);
  assert.deepEqual(f.state.tasks.filter(t => t.jobId === 'original-gemma-job'), originalTasks);
  const rows = comparisonRows(f.state, batch.sample);
  assert.equal(rows.length, 4);
  const partialRows = rows.filter(row => row.conversationId === ids[0]);
  assert.equal(partialRows[0].votes, 2); assert.equal(partialRows[1].votes, 1);
  assert.equal(partialRows[0].cells[0].evaluationId, `gemma-evaluation-${ids[0]}`);
  assert.equal(partialRows[1].cells[0].status, 'failed');
  assert.ok(rows.filter(row => row.conversationId === ids[1]).every(row => row.votes === 2));
});
