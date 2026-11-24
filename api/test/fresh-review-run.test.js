import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { digest, sourceFingerprint } from '../src/evaluation-context.js';
import { validateFreshReviewManifest, assertFreshReviewSources, freshReviewChunks, freshReviewConfiguration,
  freshReviewOptions, createFreshReviewStore, executeFreshReview, completedFreshReviewSelection } from '../src/fresh-review-run.js';
import { parseReviewArguments } from '../scripts/run-review-selection.js';

function fixture(count = 2) {
  const state = createState(false);
  state.catalog = state.catalog.filter(item => item.active && item.method === 'IA' && item.type === 'Flag').slice(0, 2);
  state.catalogVersions = state.catalogVersions.filter(item => state.catalog.some(variable => variable.id === item.itemId));
  state.settings.aiPolicy = { mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local', fallbackId: null, version: 1 };
  state.settings.includeOpenConversations = true;
  state.settings.automation = null;
  state.reviewSelection = { id: 'previous-selection', selectionHash: 'a'.repeat(64) };
  state.conversations = Array.from({ length: count }, (_, index) => ({ id: String(index + 1), country: 'HN', countryName: 'Honduras',
    date: '2026-11-16', activityDate: '2026-11-18', activityAt: '2026-11-18T16:00:00.000Z', lastActivityAt: '2026-11-18T16:00:00.000Z',
    startedAt: '2026-11-16T16:00:00.000Z', completed: true, sourceDocumentId: String(index + 100), sourceDocumentHash: 'b'.repeat(64),
    messages: [{ id: `message-${index}`, actor: 'cliente', text: 'Consulta sintética para pruebas.', timestamp: '2026-11-18T16:00:00.000Z' }] }));
  const manifest = { schemaVersion: 1, id: 'synthetic-fresh-review', createdAt: new Date().toISOString(),
    reviewDeadline: '2099-11-25T10:00:00-06:00', preparatoryOnly: false, authorizedForExecution: true,
    profiles: ['clef-local', 'gemma-local'], scope: { from: '2026-11-17', to: '2026-11-19', timezone: 'America/Tegucigalpa' },
    caseCount: count, expectedNewEvaluations: count * 2, counts: { HN: count, PA: 0, CR: 0, SV: 0, MX: 0, NI: 0 },
    cases: state.conversations.map(c => ({ conversationId: c.id, country: c.country, activityDate: c.activityDate, activityAt: c.activityAt,
      sourceDocumentId: c.sourceDocumentId, sourceDocumentHash: c.sourceDocumentHash, currentSourceHash: sourceFingerprint(c),
      sourceCompleted: c.completed, messageCount: c.messages.length })) };
  manifest.selectionHash = digest({ scope: manifest.scope, cases: manifest.cases });
  const calls = [];
  const registry = new ModelRegistry(manifest.profiles.map(id => ({ id, label: id, provider: 'gateway', enabled: true,
    model: id === 'clef-local' ? 'clef-flash' : 'gemma-4-26b-a4b-it-mlx',
    evaluator: { configured: true, async evaluate(conversation, variables) {
      calls.push({ id, conversationId: conversation.id, variables: variables.map(variable => variable.id) });
      return { model: id === 'clef-local' ? 'clef-flash' : 'gemma-4-26b-a4b-it-mlx', results: variables.map(variable => ({
        variableId: variable.id, type: variable.type, method: variable.method, status: 'evaluado', value: 0,
        reason: 'Resultado sintético.', evidence: [] })) };
    } } })));
  const scopedRead = jobId => {
    const value = structuredClone(state), ids = state.jobs.find(job => job.id === jobId)?.conversationIds || [];
    value.conversations = [];
    value.tasks = value.tasks.filter(task => task.jobId === jobId);
    value.attempts = value.attempts.filter(attempt => attempt.jobId === jobId);
    value.operationalRefs = value.operationalRefs.filter(ref => ids.includes(ref.id));
    value.evaluations = value.evaluations.filter(e => e.jobId === jobId || value.operationalRefs.some(ref => ref.evaluationId === e.id));
    return value;
  };
  const store = { async readSchedulerState() { return { jobs: structuredClone(state.jobs) }; },
    evaluationWorker(jobId) {
      return { async read() { return scopedRead(jobId); },
        async readWithConversations({ conversationIds }) { return { ...scopedRead(jobId), conversations: structuredClone(state.conversations.filter(c => conversationIds.includes(c.id))) }; },
        async transaction(fn) {
          const value = scopedRead(jobId); const result = await fn(value);
          for (const key of ['jobs', 'tasks', 'attempts', 'evaluations', 'operationalRefs']) {
            const merged = new Map(state[key].map(item => [item.id, item]));
            for (const item of value[key]) merged.set(item.id, item);
            state[key] = [...merged.values()];
          }
          state.settings = value.settings; state.metadata = value.metadata;
          return structuredClone(result);
        } };
    } };
  return { state, store, registry, manifest, calls };
}

test('fresh manifest validates integrity, authorization and forbids prior evaluation IDs', () => {
  const { manifest } = fixture();
  assert.equal(validateFreshReviewManifest(manifest), manifest);
  const prepared = { ...manifest, preparatoryOnly: true, authorizedForExecution: false };
  assert.equal(validateFreshReviewManifest(prepared), prepared);
  assert.throws(() => validateFreshReviewManifest(prepared, { authorize: true }), { code: 'REVIEW_REQUEST_NOT_AUTHORIZED' });
  for (const change of [
    draft => { draft.cases[0].country = 'MX'; },
    draft => { draft.caseCount += 1; },
    draft => { draft.profiles.reverse(); },
    draft => { draft.cases[0].evaluationId = 'saved-old'; draft.selectionHash = digest({ scope: draft.scope, cases: draft.cases }); },
  ]) { const changed = structuredClone(manifest); change(changed); assert.throws(() => validateFreshReviewManifest(changed), { code: 'INVALID_REVIEW_REQUEST' }); }
});

test('explicit chunks cap 100, preserve all IDs once, use stable idempotency and omit start-date filtering', () => {
  const { manifest, state, registry } = fixture(214);
  const chunks = freshReviewChunks(manifest);
  assert.deepEqual(chunks.map(chunk => chunk.ids.length), [100, 100, 14]);
  assert.equal(new Set(chunks.flatMap(chunk => chunk.ids)).size, 214);
  assert.deepEqual(freshReviewChunks(structuredClone(manifest)), chunks);
  const options = freshReviewOptions(manifest, chunks[0], freshReviewConfiguration(state, registry, manifest));
  assert.equal(options.pendingOnly, false); assert.equal(options.includeOpen, true);
  assert.ok(!('from' in options)); assert.ok(!('to' in options));
  for (const key of ['automation', 'dailyActivity', 'scheduleDate', 'oneOffRun', 'largeBatch', 'maintenanceId']) assert.ok(!(key in options));
});

test('source guard accepts a pilot subset and rejects missing, changed or extra members', () => {
  const { manifest, state } = fixture();
  assertFreshReviewSources(manifest, [state.conversations[0]], [state.conversations[0].id]);
  assert.throws(() => assertFreshReviewSources(manifest, [state.conversations[0]]), { code: 'REVIEW_SOURCE_SCOPE_CHANGED' });
  const changed = structuredClone(state.conversations); changed[0].messages[0].text = 'Otra entrada';
  assert.throws(() => assertFreshReviewSources(manifest, changed), { code: 'SOURCE_CHANGED' });
});

test('new run calls both models for all items despite historical results, rerun is idempotent and preserves settings', async () => {
  const f = fixture();
  const original = { id: 'old-answer', conversationId: '1', jobId: 'old-job', createdAt: '2026-11-19T00:00:00Z', purpose: 'operational', results: [] };
  f.state.jobs.push({ id: 'old-job', status: 'completed' });
  f.state.evaluations.push(original); f.state.operationalRefs.push({ id: '1', evaluationId: original.id });
  const settings = structuredClone(f.state.settings);
  let saved;
  const progress = await executeFreshReview({ ...f, checkpoint: async value => { saved = structuredClone(value); } });
  assert.equal(progress.status, 'completed'); assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every(call => call.variables.length === 2));
  assert.deepEqual(f.state.evaluations.find(e => e.id === original.id), original);
  assert.deepEqual(f.state.settings, settings);
  assert.equal(f.state.tasks.length, 4);
  await executeFreshReview({ ...f, progress: saved });
  assert.equal(f.calls.length, 4); assert.equal(f.state.tasks.length, 4);
  const selection = completedFreshReviewSelection(f.state, f.manifest, progress);
  assert.equal(selection.caseCount, 2); assert.equal(selection.evaluationCount, 4);
  assert.equal(selection.timeCorrectionCount, 0);
  assert.ok(selection.cases.every(c => c.models.every(model => model.evaluationId !== original.id)));
  assert.deepEqual(progress.previousSelection, { id: 'previous-selection', selectionHash: 'a'.repeat(64) });
});

test('a running foreign batch waits without changing its jobs, schedules or tasks', async () => {
  const f = fixture();
  f.state.jobs.push({ id: 'other', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const events = [];
  let waits = 0;
  const progress = await executeFreshReview({ ...f, report: value => events.push(value), wait: async () => {
    waits += 1; assert.equal(f.state.jobs.find(job => job.id === 'other').status, 'running');
    f.state.jobs.find(job => job.id === 'other').status = 'completed'; // separate simulated worker finishes
  } });
  assert.equal(waits, 1); assert.equal(progress.status, 'completed');
  assert.ok(events.some(event => event.event === 'waiting_for_worker'));
});

test('worker refuses unrelated settings mutation and refuses to recover a stale foreign run', async () => {
  const f = fixture(), chunk = freshReviewChunks(f.manifest)[0], configuration = freshReviewConfiguration(f.state, f.registry, f.manifest);
  f.state.jobs.push({ id: 'own', status: 'running', conversationIds: chunk.ids });
  const guarded = createFreshReviewStore(f.store, f.registry, f.manifest, chunk, configuration, 'own');
  await assert.rejects(guarded.transaction(state => { state.settings.dailyEnabled = !state.settings.dailyEnabled; }), { code: 'REVIEW_SETTINGS_CHANGED' });
  f.state.jobs.push({ id: 'foreign', status: 'running' });
  await assert.rejects(guarded.transaction(state => { state.jobs.find(job => job.id === 'foreign').status = 'interrupted'; }), { code: 'REVIEW_FOREIGN_JOB_CHANGED' });
  assert.equal(f.state.jobs.find(job => job.id === 'foreign').status, 'running');
});

test('publication refuses partial new answers and no result is relabeled as current', async () => {
  const f = fixture(); const progress = await executeFreshReview(f);
  const originalHash = f.state.evaluations[0].sourceHash;
  f.state.evaluations[0].partial = true;
  assert.throws(() => completedFreshReviewSelection(f.state, f.manifest, progress), { code: 'REVIEW_SELECTION_INCOMPLETE' });
  f.state.evaluations[0].partial = false;
  f.state.conversations[0].messages[0].text = 'Fuente posterior';
  assert.throws(() => completedFreshReviewSelection(f.state, f.manifest, progress), { code: 'SOURCE_CHANGED' });
  assert.equal(f.state.evaluations[0].sourceHash, originalHash);
});

test('CLI modes require a single safe request source; status/check never imply execution', () => {
  assert.deepEqual(parseReviewArguments(['--status', '--request-id', 'fresh-review214-20261125']), { mode: 'status', requestId: 'fresh-review214-20261125' });
  assert.deepEqual(parseReviewArguments(['--run', '--manifest', '/private/request.json', '--publish-on-complete']), { mode: 'run', manifestFile: '/private/request.json', publishOnComplete: true });
  for (const args of [[], ['--run', '--check', '--request-id', 'x'], ['--run', '--manifest', 'relative.json'], ['--run', '--request-id', '../x'], ['--status', '--request-id', 'x', '--publish-on-complete'], ['--check', '--request-id', 'x', '--manifest', '/x']]) {
    assert.throws(() => parseReviewArguments(args), { code: 'INVALID_ARGUMENTS' });
  }
});


test('an interrupted new batch resumes only its own missing items, preserving cancelled historical runs', async () => {
  const f = fixture(1);
  const gemma = f.registry.profiles.find(profile => profile.id === 'gemma-local').evaluator;
  const evaluate = gemma.evaluate.bind(gemma); let attempts = 0;
  gemma.evaluate = async (conversation, variables) => {
    attempts += 1; const answer = await evaluate(conversation, variables);
    return attempts <= 2 ? { ...answer, results: attempts === 1 ? answer.results.slice(0, 1) : [] } : answer;
  };
  const cancelled = { id: 'cancelled-old', status: 'cancelled', automation: { cancelledAt: '2026-11-20T00:00:00Z' } };
  const oldTask = { id: 'cancelled-task', jobId: cancelled.id, status: 'deferred' };
  f.state.jobs.push(cancelled); f.state.tasks.push(oldTask);
  const progress = await executeFreshReview(f);
  assert.equal(progress.status, 'completed');
  assert.equal(progress.chunks[0].launchRounds, 2);
  assert.equal(f.state.jobs.filter(job => job.idempotencyKey).length, 1);
  assert.equal(f.state.tasks.filter(task => task.jobId === progress.chunks[0].jobId).length, 2);
  assert.deepEqual(f.state.jobs.find(job => job.id === cancelled.id), cancelled);
  assert.deepEqual(f.state.tasks.find(task => task.id === oldTask.id), oldTask);
  assert.deepEqual(f.calls.filter(call => call.id === 'gemma-local').map(call => call.variables.length), [2, 1, 1]);
});

test('changing the verified configuration prevents starting an inference', async () => {
  const f = fixture();
  f.manifest.expectedHashes = { modelProfiles: { 'clef-local': 'f'.repeat(64), 'gemma-local': 'f'.repeat(64) } };
  await assert.rejects(executeFreshReview(f), { code: 'REVIEW_CONFIGURATION_CHANGED' });
  assert.equal(f.calls.length, 0); assert.equal(f.state.jobs.length, 0);
});
