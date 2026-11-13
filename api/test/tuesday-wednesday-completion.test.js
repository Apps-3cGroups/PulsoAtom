import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { catalogV5 } from '../src/catalog-v5.js';
import { ModelRegistry } from '../src/model-registry.js';
import { catalogReferences, evaluationContext, digest } from '../src/evaluation-context.js';
import { RECOVERY_ID, RECOVERY_JOBS, recoveryPlan } from '../src/gemma-incident-recovery.js';
import { resumeEvaluationBatch } from '../src/evaluation-service.js';
import { COMPLETION_ID, COMPLETION_KEYS, COMPLETION_MODELS, makeCompletionPlan, assertCompletionPlan,
  assertCompletionSource, assertOriginalIncident, prepareCompletion, finishCompletion, completionStatus,
  assertCompletionMutation, assertPhaseJob, completionTasks, finalizedCompletion, setCompletionConcurrency } from '../src/tuesday-wednesday-completion.js';
import { executeCompletion, processState, recordSpawnedWorker, waitForWorkerAssignment, persistPrivateBackup } from '../scripts/complete-tuesday-wednesday.js';

const fail = (fn, code) => assert.throws(fn, e => e.code === code);
const reject = (promise, code) => assert.rejects(promise, e => e.code === code);
const flagIds = ['cliente_amenazo_cancelar_pedido', 'cliente_felicito_al_asistente'];
function conversation(id, country = 'HN', activity = '2026-11-10T18:00:00Z', batch = '215', started = activity) {
  return { id, country, completed: false, startedAt: started, lastActivityAt: activity, endedAt: activity,
    date: '2026-11-10', ingestionBatchId: batch, client: { name: 'PRIVATE_CLIENT' }, agent: { id: 'agent', name: 'PRIVATE_AGENT' },
    media: [], messages: [{ id: `message-${id}`, actor: 'cliente', text: 'PRIVATE_TRANSCRIPT', timestamp: activity }] };
}
function fixture() {
  const calls = [], catalog = catalogV5.filter(v => flagIds.includes(v.id)).map(v => ({ ...structuredClone(v), active: true }));
  const registry = new ModelRegistry(COMPLETION_MODELS.map(id => ({ id, provider: 'gateway', model: `synthetic-${id}`, enabled: true,
    evaluator: { configured: true, protocol: 'chat', toolKey: 'synthetic-tool', baseUrl: 'http://synthetic.invalid',
      async evaluate(c, variables) { calls.push({ conversationId: c.id, profileId: id, variables: variables.map(v => v.id) });
        return { model: `synthetic-${id}`, results: variables.map(v => ({ variableId: v.id, type: v.type, method: v.method, status: 'evaluado', value: 0, evidence: [], reason: 'Synthetic response' })) }; } } })));
  const state = { metadata: { demo: false }, settings: { dailyEnabled: true, dailyLimitPerCountry: 200, evaluationMaintenance: RECOVERY_ID,
    version: 17, appearance: { fontScale: 1.5, version: 3 }, aiPolicy: { mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local', version: 1 },
    gemmaIncidentRecovery: { id: RECOVERY_ID, status: 'prepared' } }, catalog,
    catalogVersions: catalog.map(v => ({ id: `${v.id}:${v.version}`, itemId: v.id, version: v.version, snapshot: v })),
    conversations: [], tasks: [], evaluations: [], attempts: [], jobs: [], operationalRefs: [], reviews: [], verdicts: [], comparisons: [],
    modelPolicies: [], catalogAudit: [], users: [], sessions: [], exposures: [], validations: [] };
  const profiles = COMPLETION_MODELS.map(id => registry.snapshot(registry.resolve(id)));
  for (let i = 0; i < 364; i++) {
    const c = conversation(`old-${i}`, i === 54 ? 'PA' : 'HN'); state.conversations.push(c);
    const jobId = RECOVERY_JOBS[i < 52 ? 0 : 1];
    for (let p = 0; p < 2; p++) {
      const partial = i === 52 && p === 0 || [53, 54].includes(i) && p === 1;
      const results = catalog.slice(0, partial ? 1 : 2).map(v => ({ variableId: v.id, type: v.type, method: v.method, status: 'evaluado', value: 0, evidence: [], reason: 'Retained valid answer' }));
      const t = { id: `task-${i}-${p}`, jobId, conversationId: c.id, profile: profiles[p], fallback: null, codeResults: [],
        context: evaluationContext(c, catalog), status: partial ? 'partial' : 'completed', round: 1, evaluationId: `eval-${i}-${p}`,
        error: partial ? { code: 'AI_CONFIGURATION', message: 'PRIVATE_PROVIDER_ERROR' } : null,
        profileStates: { [profiles[p].id]: { model: profiles[p].model, results, validationErrors: [] } } };
      state.tasks.push(t); state.evaluations.push({ id: t.evaluationId, jobId, taskId: t.id, conversationId: c.id, profileId: t.profile.id,
        purpose: 'operational', partial, createdAt: '2026-11-12T20:00:00Z', ...t.context, modelConfiguration: t.profile,
        catalogVersions: catalogReferences(catalog), results });
    }
    state.operationalRefs.push({ id: c.id, evaluationId: `eval-${i}-0` });
  }
  state.jobs = RECOVERY_JOBS.map((id, index) => ({ id, purpose: 'operational', mode: 'dual', status: index ? 'partial' : 'completed',
    dailyActivity: { date: '2026-11-10', timezone: 'America/Tegucigalpa' },
    conversationIds: state.conversations.slice(index ? 52 : 0, index ? 364 : 52).map(c => c.id),
    modelProfiles: profiles, catalogVersions: catalogReferences(catalog), maintenanceId: RECOVERY_ID, concurrency: 2,
    executionOrder: 'model-first', createdAt: '2026-11-11T20:00:00Z' }));
  for (let i = 0; i < 167; i++) state.conversations.push(conversation(`tuesday-${i}`));
  for (let i = 0; i < 23; i++) state.conversations.push(conversation(`panama-${i}`, 'PA', '2026-11-12T18:00:00Z', '236', '2026-11-11T18:00:00Z'));
  for (let i = 0; i < 20; i++) state.conversations.push(conversation(`honduras-${i}`, 'HN', '2026-11-12T18:00:00Z', '237', '2026-11-11T18:00:00Z'));
  const incident = { id: RECOVERY_ID, status: 'blocked', plan: { ...recoveryPlan(state), priorMaintenance: null } };
  return { state, registry, calls, incident };
}
function prepared() {
  const f = fixture(), plan = makeCompletionPlan(f.state, f.registry, f.incident, '2026-11-13T01:00:00Z');
  prepareCompletion(f.state, f.registry, plan, '2026-11-13T01:00:01Z'); return { ...f, plan };
}
function memory(f) {
  let current = structuredClone(f.state), queue = Promise.resolve();
  return { async read() { await queue; return structuredClone(current); }, async readWithConversations(options) {
    await queue; const state = structuredClone(current); if (options?.conversationIds) state.conversations = state.conversations.filter(c => options.conversationIds.includes(c.id)); return state;
  }, transaction(fn) { const run = queue.then(async () => { const before = structuredClone(current), draft = structuredClone(current), result = await fn(draft);
    assertCompletionMutation(before, draft, f.plan); current = draft; return structuredClone(result); }); queue = run.catch(() => {}); return run; } };
}

test('plan freezes exactly 3 retries + 167 Tuesday + 43 Wednesday and excludes 725 completed tasks', () => {
  const f = fixture(), before = structuredClone(f.state), plan = makeCompletionPlan(f.state, f.registry, f.incident);
  assertCompletionPlan(plan); assert.equal(plan.protected.length, 725); assert.equal(plan.tuesday.length, 167); assert.equal(plan.wednesday.length, 43);
  assert.deepEqual(plan.retry.map(r => r.profileId).sort(), ['clef-local', 'gemma-local', 'gemma-local']);
  assert.equal(JSON.stringify(plan).includes('PRIVATE_'), false); assert.deepEqual(f.state, before); assert.equal(f.calls.length, 0);
  assert.equal(plan.priorMaintenance, null);
});
test('scope rejects changed counts, missing imports, duplicate IDs, prior tasks and source changes', () => {
  for (const mutate of [s => s.conversations.pop(), s => s.conversations.push(conversation('extra')), s => { s.conversations.at(-1).ingestionBatchId = '238'; },
    s => { s.conversations.at(-1).startedAt = '2026-11-12T18:00:00Z'; }, s => s.tasks.push({ id: 'another', conversationId: 'honduras-0', status: 'failed' }),
    s => { s.conversations.find(c => c.id === 'old-52').messages[0].text = 'changed'; }]) {
    const f = fixture(); mutate(f.state); assert.throws(() => makeCompletionPlan(f.state, f.registry, f.incident));
  }
  const f = fixture(); f.state.conversations.push(f.state.conversations[0]); fail(() => makeCompletionPlan(f.state, f.registry, f.incident), 'DUPLICATE_SOURCE');
});
test('maintenance preparation preserves scheduling, permissions and completed answers, refusing a live worker', () => {
  const f = fixture(), plan = makeCompletionPlan(f.state, f.registry, f.incident), before = structuredClone(f.state);
  fail(() => assertOriginalIncident(f.state, f.incident, true), 'INCIDENT_NOT_STOPPED');
  const altered = structuredClone(f.incident); altered.plan.priorMaintenance = RECOVERY_ID;
  fail(() => assertOriginalIncident(f.state, altered), 'INCIDENT_NOT_STOPPED');
  prepareCompletion(f.state, f.registry, plan, 'now');
  assert.deepEqual(f.state.evaluations, before.evaluations); assert.deepEqual(f.state.tasks, before.tasks);
  assert.equal(f.state.settings.dailyEnabled, true); assert.equal(f.state.settings.dailyLimitPerCountry, 200); assert.equal(f.state.settings.version, 17);
  assert.deepEqual(f.state.settings.appearance, before.settings.appearance); assert.equal(f.state.settings.evaluationMaintenance, RECOVERY_ID);
});
test('manifest and frozen context reject drift before execution or duplicate assignment', () => {
  const f = prepared();
  for (const mutate of [p => p.tuesday.pop(), p => { p.retry[0].sourceHash = 'changed'; }, p => { p.protected[0].taskHash = 'changed'; }, p => { p.priorMaintenance = RECOVERY_ID; }]) {
    const p = structuredClone(f.plan); mutate(p); fail(() => assertCompletionPlan(p), 'INVALID_COMPLETION_MANIFEST');
  }
  const selected = [f.plan.tuesday[0].id]; assertCompletionSource(f.state, f.plan, selected, true);
  f.state.tasks.push({ id: 'unexpected', conversationId: selected[0] });
  fail(() => assertCompletionSource(f.state, f.plan, selected, true), 'CONVERSATION_ALREADY_ASSIGNED');
  f.state.tasks.pop(); f.state.conversations.find(c => c.id === selected[0]).messages[0].text += ' changed';
  fail(() => assertCompletionSource(f.state, f.plan, selected), 'SOURCE_CHANGED');
});
test('mutation guard blocks unrelated data, completed tasks, saved answers, identities and retained variable loss', () => {
  const f = prepared();
  for (const mutate of [s => { s.settings.dailyLimitPerCountry = 999; }, s => { s.settings.appearance.fontScale = 2; },
    s => { s.tasks.find(t => t.status === 'completed').status = 'pending'; }, s => { s.evaluations[0].results[0].value = 1; },
    s => { s.tasks.find(t => t.status === 'partial').context.sourceHash = 'changed'; },
    s => { s.tasks.find(t => t.status === 'partial').profileStates = {}; }, s => { s.jobs[0].modelProfiles = []; },
    s => s.jobs.push({ id: 'foreign', idempotencyKey: 'not-this-cohort' }), s => s.tasks.splice(0, 1)]) {
    const draft = structuredClone(f.state); mutate(draft); assert.throws(() => assertCompletionMutation(f.state, draft, f.plan));
  }
  const draft = structuredClone(f.state); draft.tasks.find(t => t.status === 'partial').status = 'pending';
  assertCompletionMutation(f.state, draft, f.plan);
  const foreign = structuredClone(f.state), target = f.plan.retry[0].id;
  foreign.jobs.push({ id: 'foreign-job', status: 'completed' });
  foreign.tasks.push({ id: 'foreign-task', conversationId: target, jobId: 'foreign-job', status: 'partial' });
  foreign.attempts.push({ id: 'foreign-attempt', taskId: 'foreign-task', jobId: 'foreign-job', status: 'running' });
  for (const key of ['tasks', 'attempts']) {
    const altered = structuredClone(foreign); altered[key].at(-1).status = 'completed';
    fail(() => assertCompletionMutation(foreign, altered, f.plan), 'PROTECTED_RECORD_CHANGED');
  }
});
test('real resume reuses retained valid variables and never invokes either completed task again', async () => {
  const f = prepared(), store = memory(f), before = await store.read();
  const execution = await resumeEvaluationBatch(store, f.registry, RECOVERY_JOBS[1], { conversationIds: f.plan.retry.map(r => r.id) });
  await execution.completion;
  assert.equal(f.calls.length, 3); assert.ok(f.calls.every(c => c.variables.length === 1 && c.variables[0] === f.state.catalog[1].id));
  const after = await store.read();
  assert.ok(f.plan.retry.every(r => after.tasks.find(t => t.id === r.taskId).status === 'completed'), JSON.stringify(after.tasks.filter(t=>f.plan.retry.some(r=>r.taskId===t.id)).map(t=>({id:t.id,status:t.status,error:t.error}))));
  for (const old of before.tasks.filter(t => t.status === 'completed')) assert.deepEqual(after.tasks.find(t => t.id === old.id), old);
  assert.equal(after.evaluations.length, before.evaluations.length + 3);
});
test('phases run retries then Tuesday167 then Wednesday43, and repeating orchestration creates nothing twice', async () => {
  const f = prepared(), store = memory(f), operations = [];
  const complete = async (jobId, selected) => store.transaction(s => { for (const t of s.tasks.filter(t => t.jobId === jobId && selected.includes(t.conversationId))) if (t.status !== 'completed') t.status = 'completed'; s.jobs.find(j => j.id === jobId).status = 'completed'; });
  const resumeBatch = async (_store, _registry, jobId, options) => { operations.push(['resume', options.conversationIds.length]); await complete(jobId, options.conversationIds); return { job: { id: jobId }, completion: Promise.resolve() }; };
  const startBatch = async (_store, _registry, options) => {
    operations.push(['start', options.conversationIds.length]); assert.equal(options.concurrency, 1); assert.equal(options.largeBatch, true);
    assert.equal(options.maintenanceId, RECOVERY_ID); assert.equal(options.scheduleDate, undefined); assert.equal(options.dailyActivity, undefined);
    const job = { id: `new-${options.max}`, idempotencyKey: options.idempotencyKey, purpose: 'operational', mode: 'dual', maintenanceId: RECOVERY_ID,
      conversationIds: options.conversationIds, modelProfiles: f.plan.profiles, status: 'completed' };
    await store.transaction(s => { s.jobs.push(job); s.tasks.push(...options.conversationIds.flatMap(id => f.plan.profiles.map(profile => ({ id: `${id}-${profile.id}`, jobId: job.id, conversationId: id, profile, status: 'completed' })))); });
    return { job, completion: Promise.resolve(job) };
  };
  await executeCompletion(store, f.registry, f.plan, { startBatch, resumeBatch });
  assert.deepEqual(operations, [['resume', 3], ['start', 167], ['start', 43]]);
  await executeCompletion(store, f.registry, f.plan, { startBatch, resumeBatch });
  assert.equal(operations.length, 3);
  const state = await store.read(); assert.equal(completionTasks(state, f.plan).length, 423);
  const status = completionStatus(state, f.plan, { status: 'running' }, true);
  assert.equal(status.completedConversations, 213); assert.equal(status.remainingModelTasks, 0); assert.equal(status.preservedCompletedTasks, 725);
  const originalSettings = structuredClone(state.settings);
  finishCompletion(state, f.registry, f.plan, '2026-11-13T03:00:00Z');
  assert.equal(state.settings.evaluationMaintenance, null); assert.equal(state.settings.dailyEnabled, originalSettings.dailyEnabled);
  assert.equal(state.settings.gemmaIncidentRecovery.status, 'completed');
  // Simulate a crash immediately after the database commit, before either
  // private manifest receives its final filesystem write.
  const staleManifest = { status: 'blocked', errorCode: 'FILESYSTEM_ERROR' };
  assert.equal(finalizedCompletion(state, f.registry, f.plan), '2026-11-13T03:00:00Z');
  assertCompletionSource(state, f.plan, [...f.plan.retry, ...f.plan.tuesday, ...f.plan.wednesday].map(c => c.id));
  const recovered = completionStatus(state, f.plan, staleManifest, false);
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.errorCode, null);
  assert.equal(state.settings.evaluationMaintenance, null);
  assert.equal(finalizedCompletion(state, f.registry, f.plan), '2026-11-13T03:00:00Z');
});
test('concurrency starts at one and requires ten completed fresh conversations before a controlled increase', () => {
  const f = prepared(); assert.equal(f.state.settings.tuesdayWednesdayCompletion.concurrency, 1);
  fail(() => setCompletionConcurrency(f.state, f.plan, 2), 'CONCURRENCY_PILOT_REQUIRED');
  fail(() => setCompletionConcurrency(f.state, f.plan, 3), 'INVALID_CONCURRENCY');
  const job = { id: 'pilot-job', idempotencyKey: COMPLETION_KEYS.tuesday, status: 'interrupted', concurrency: 1 };
  f.state.jobs.push(job);
  f.state.tasks.push(...f.plan.tuesday.slice(0, 10).flatMap(c => COMPLETION_MODELS.map(profileId => ({ id: `${c.id}-${profileId}`, jobId: job.id, conversationId: c.id, profile: { id: profileId }, status: 'completed' }))));
  const before = structuredClone(f.state.settings);
  setCompletionConcurrency(f.state, f.plan, 2); assert.equal(job.concurrency, 2);
  assert.equal(f.state.settings.dailyLimitPerCountry, before.dailyLimitPerCountry); assert.deepEqual(f.state.settings.appearance, before.appearance);
  f.state.tasks.push({ id: 'interrupted-by-stop', jobId: job.id, conversationId: f.plan.tuesday[10].id, status: 'interrupted', error: null });
  setCompletionConcurrency(f.state, f.plan, 2); // the old PID was proved dead before this controlled restart
  f.state.tasks.at(-1).error = { code: 'AI_TIMEOUT' }; fail(() => setCompletionConcurrency(f.state, f.plan, 2), 'CONCURRENCY_PILOT_REQUIRED');
  f.state.tasks.pop();
  f.state.tasks.at(-1).status = 'partial'; fail(() => setCompletionConcurrency(f.state, f.plan, 2), 'CONCURRENCY_PILOT_REQUIRED');
});
test('an atomic orphan backup can be reused after a launch crash only when its protected snapshot matches', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'completion-backup-')), file = path.join(directory, 'backup.json');
  try {
    const snapshot = { id: COMPLETION_ID, createdAt: 'one', scopeHash: 'frozen', settings: { dailyLimitPerCountry: 200 } };
    await persistPrivateBackup(file, snapshot);
    const original = await readFile(file, 'utf8'); assert.equal((await stat(file)).mode & 0o777, 0o600);
    await persistPrivateBackup(file, { ...snapshot, createdAt: 'two' }); assert.equal(await readFile(file, 'utf8'), original);
    await reject(persistPrivateBackup(file, { ...snapshot, scopeHash: 'changed' }), 'BACKUP_CHANGED');
    assert.equal(await readFile(file, 'utf8'), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('foreign duplicate job, not finished state, wrong process and live PID cannot silently proceed', async () => {
  const f = prepared(); fail(() => finishCompletion(f.state, f.registry, f.plan, 'now'), 'COMPLETION_NOT_FINISHED');
  f.state.jobs.push({ id: 'a', idempotencyKey: COMPLETION_KEYS.tuesday }, { id: 'b', idempotencyKey: COMPLETION_KEYS.tuesday });
  fail(() => assertPhaseJob(f.state, f.plan, 'tuesday'), 'DUPLICATE_COMPLETION_JOB');
  assert.deepEqual(await processState(10, '/correct.js', { kill() { throw Object.assign(new Error(), { code: 'ESRCH' }); } }), { alive: false });
  assert.deepEqual(await processState(10, '/correct.js', { kill() {}, read: async p => p.endsWith('stat') ? '10 (node) S text' : 'node\0/correct.js\0--worker\0' }), { alive: true });
  await reject(processState(10, '/correct.js', { kill() {}, read: async p => p.endsWith('stat') ? '10 (node) S text' : 'node\0/another.js\0--worker\0' }), 'WORKER_IDENTITY_CHANGED');
  assert.deepEqual(await processState(10, '/correct.js', { kill() {}, read: async () => '10 (node) Z text' }), { alive: false });
});

test('launch handshake publishes the live PID before detach and rejects a different child assignment', async () => {
  const child = new EventEmitter(); child.pid = 1234; let detached = false, saved, writes = 0;
  child.unref = () => { assert.equal(saved.pid, 1234); detached = true; };
  const manifest = { id: COMPLETION_ID, status: 'prepared', pid: null };
  const recorded = recordSpawnedWorker(manifest, child, async (_file, value) => { saved = structuredClone(value); writes++; }, '/synthetic/manifest');
  child.emit('spawn'); await recorded;
  assert.equal(writes, 1); assert.equal(detached, true);
  assert.equal((await waitForWorkerAssignment(1234, { read: async () => saved, pause: async () => {} })).pid, 1234);
  await reject(waitForWorkerAssignment(4321, { read: async () => saved, pause: async () => {} }), 'WORKER_ASSIGNMENT_CHANGED');
  let tries = 0;
  await waitForWorkerAssignment(1234, { read: async () => ++tries < 3 ? { ...saved, pid: null } : saved, pause: async () => {} });
  assert.equal(tries, 3);
});

test('scoped MySQL loader retains all job guards, caches isolated answers and rejects unsafe writes before SQL', async () => {
  const { CompletionStore } = await import('../src/tuesday-wednesday-completion-store.js');
  const f = prepared();
  f.state.jobs.push({ id: 'unrelated-job', status: 'completed', conversationIds: ['unrelated-chat'] });
  f.state.tasks.push({ id: 'unrelated-task', jobId: 'unrelated-job', conversationId: 'unrelated-chat', status: 'completed', evaluationId: 'unrelated-eval' });
  f.state.evaluations.push({ id: 'unrelated-eval', conversationId: 'unrelated-chat', results: [{ reason: 'UNRELATED_PRIVATE_DATA' }] });
  const tables = { catalog_items: f.state.catalog, catalog_versions: f.state.catalogVersions, evaluation_jobs: f.state.jobs,
    model_policies: [], evaluation_tasks: f.state.tasks, evaluation_attempts: f.state.attempts,
    operational_refs: f.state.operationalRefs, evaluations: f.state.evaluations };
  const selects = [], writes = [];
  const connection = { async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(...args) { writes.push(args); return [[]]; },
    async query(sql, ids = []) {
      selects.push(sql);
      if (sql.includes('app_lock')) return [[{ id: 1 }]];
      if (sql.includes('FROM portal_settings')) return [[{ id: 'settings', payload: f.state.settings }, { id: 'metadata', payload: f.state.metadata }]];
      if (sql.startsWith('SELECT DISTINCT')) return [[...new Set(f.state.tasks.filter(t => ids.includes(t.conversationId)).map(t => t.jobId))].map(jobId => ({ jobId }))];
      const table = sql.match(/FROM (\w+)/)?.[1], values = tables[table]; assert.ok(values, sql);
      if (sql.startsWith('SELECT payload')) return [values.map(payload => ({ payload }))];
      if (sql.startsWith('SELECT id FROM evaluations')) return [values.filter(r => ids.includes(r.conversationId)).map(r => ({ id: r.id }))];
      const key = sql.includes('$.jobId') ? 'jobId' : 'id', selected = values.filter(r => ids.includes(r[key]));
      if (sql.includes(' AS revision')) return [selected.map(payload => ({ id: payload.id, revision: digest(payload) }))];
      if (sql.startsWith('SELECT id, payload')) return [selected.map(payload => ({ id: payload.id, payload }))];
      throw new Error(sql);
    } };
  const store = new CompletionStore({}, f.plan); await store.pool.end(); store.pool = { getConnection: async () => connection, end: async () => {} };
  const first = await store.load(connection);
  assert.ok(first.jobs.some(j => j.id === 'unrelated-job'));
  assert.ok(!first.tasks.some(t => t.id === 'unrelated-task')); assert.ok(!first.evaluations.some(e => e.id === 'unrelated-eval'));
  const scopedPayloads = () => selects.filter(s => s.startsWith('SELECT id, payload') && !s.includes('portal_settings')).length;
  const payloadSelects = scopedPayloads();
  first.tasks[0].status = 'corrupted';
  const second = await store.load(connection); assert.equal(second.tasks[0].status, f.state.tasks[0].status);
  assert.equal(scopedPayloads(), payloadSelects);
  await reject(store.transaction(s => { s.settings.appearance.fontScale = 2; }), 'UNRELATED_SETTING_CHANGED');
  assert.equal(writes.length, 0); await store.close();
});
