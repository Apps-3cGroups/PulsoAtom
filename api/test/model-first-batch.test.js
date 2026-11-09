import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createState } from '../src/data/seed.js';
import { createApp } from '../src/app.js';
import { newToken, tokenHash } from '../src/auth.js';
import { ModelRegistry } from '../src/model-registry.js';
import { sourceFingerprint } from '../src/evaluation-context.js';
import { conversationView } from '../src/domain.js';
import { AppError } from '../src/errors.js';
import { startEvaluationBatch, runEvaluationBatch, resumeEvaluationBatch, evaluationModelProgress } from '../src/evaluation-service.js';

const modelIds = ['gemma-local', 'clef-local'];
const dualOptions = { modelIds, executionOrder: 'model-first' };
const config = { demo: false, origin: 'http://127.0.0.1:3000', sessionHours: 8, secureCookie: false, timezone: 'America/Tegucigalpa' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(count = 2, handler) {
  const state = createState(false);
  state.catalog = state.catalog.filter(v => v.active && v.type === 'Flag' && v.method === 'IA').slice(0, 2);
  state.catalogVersions = state.catalogVersions.filter(v => state.catalog.some(item => item.id === v.itemId));
  state.settings.aiPolicy = { mode: 'single', primaryId: 'gemma-local', fallbackId: null, version: 7 };
  state.settings.includeOpenConversations = true;
  state.settings.refreshChangedConversations = false;
  state.settings.dailyEnabled = false;
  state.conversations = Array.from({ length: count }, (_, i) => ({ id: String(i + 1), country: 'HN', date: '2026-11-07',
    completed: i % 2 === 0, startedAt: '2026-11-07T12:00:00Z', lastActivityAt: new Date(Date.UTC(2026, 10, 7, 12, 0, i)).toISOString(),
    messages: [{ id: `${i + 1}-message`, actor: 'cliente', text: 'Consulta sintética de prueba.', timestamp: '2026-11-07T12:00:00Z' }] }));
  const calls = [];
  const result = (id, variables) => ({ model: id, results: variables.map(v => ({ variableId: v.id, type: v.type, method: v.method,
    status: 'evaluado', value: 0, reason: 'Resultado sintético.', evidence: [] })) });
  const registry = new ModelRegistry(modelIds.map(id => ({ id, label: id === 'gemma-local' ? 'Gemma' : 'Clef', provider: 'demo', model: id, enabled: true,
    evaluator: { configured: true, async evaluate(conversation, variables) {
      calls.push({ profileId: id, conversationId: conversation.id, variables: variables.map(v => v.id) });
      return handler ? handler({ id, conversation, variables, result, state, calls }) : result(id, variables);
    } } })));
  const store = {
    async read() { return structuredClone(state); },
    async readWithConversations({ conversationIds } = {}) { return { ...structuredClone(state), conversations: structuredClone(state.conversations.filter(c => !conversationIds || conversationIds.includes(c.id))) }; },
    // All mutations supplied by the service are synchronous. Keep the fixture
    // atomic without cloning the entire expanding 1,000-task cohort per write.
    async transaction(fn) { return structuredClone(fn(state)); },
  };
  return { state, store, registry, calls };
}
function authenticatedApp(f, role = 'admin') {
  const token = newToken(), id = `synthetic-${role}`;
  f.state.users.push({ id, name: 'Usuario sintético', role, active: true });
  f.state.sessions.push({ id: tokenHash(token), userId: id, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const app = createApp(f.store, config, f.registry);
  const get = path => request(app).get(`/pulsoAtom/api${path}`).set('Cookie', `pulso_session=${token}`);
  const post = body => request(app).post('/pulsoAtom/api/evaluations').set('Cookie', `pulso_session=${token}`).set('Origin', config.origin).send(body);
  return { get, post };
}

test('manual dual batch accepts 100, persists scope and phases, and completes all Gemma before any Clef', async () => {
  const f = fixture(103);
  const settings = structuredClone(f.state.settings);
  const job = await runEvaluationBatch(f.store, f.registry, { ...dualOptions, max: 100, concurrency: 3 });
  assert.equal(job.caseCount, 100); assert.equal(job.total, 200); assert.equal(job.completed, 200);
  assert.equal(job.executionOrder, 'model-first'); assert.equal(job.scope, 'pending');
  assert.deepEqual(job.modelProfiles.map(p => p.id), modelIds);
  assert.deepEqual(job.conversationIds, Array.from({ length: 100 }, (_, i) => String(103 - i)));
  assert.deepEqual(f.calls.map(c => c.profileId), [...Array(100).fill('gemma-local'), ...Array(100).fill('clef-local')]);
  assert.deepEqual(f.state.settings, settings, 'An explicit dual run never mutates policy or daily scheduling');
  assert.ok(f.state.tasks.every(t => t.round === 1 && t.status === 'completed'));
  assert.deepEqual(evaluationModelProgress(f.state, job).map(p => [p.total, p.completed, p.partial, p.failed, p.running, p.pending]), [[100, 100, 0, 0, 0, 0], [100, 100, 0, 0, 0, 0]]);
});

test('the internal 500 limit requires the exact maintenance lock; comparison and daily keep their limits', async () => {
  const f = fixture(500);
  for (const options of [
    { max: 101 }, { max: 101, scheduleDate: '2026-11-08' }, { max: 21, purpose: 'comparison', modelIds },
    { max: 500 }, { max: 500, largeBatch: true }, { max: 500, largeBatch: true, maintenanceId: 'not-locked' },
  ]) await assert.rejects(startEvaluationBatch(f.store, f.registry, { ...dualOptions, ...options }), error => ['INVALID_BATCH_SIZE', 'INVALID_LARGE_BATCH'].includes(error.code));
  f.state.settings.evaluationMaintenance = 'synthetic-maintenance';
  await assert.rejects(startEvaluationBatch(f.store, f.registry, { ...dualOptions, max: 500, largeBatch: true, maintenanceId: 'other' }), { code: 'EVALUATION_MAINTENANCE' });
  await assert.rejects(startEvaluationBatch(f.store, f.registry, { ...dualOptions, max: 501, largeBatch: true, maintenanceId: 'synthetic-maintenance' }), { code: 'INVALID_BATCH_SIZE' });
  const job = await runEvaluationBatch(f.store, f.registry, { ...dualOptions, max: 500, largeBatch: true,
    maintenanceId: 'synthetic-maintenance', pendingOnly: true, refreshChanged: false, includeOpen: true,
    conversationIds: f.state.conversations.map(c => c.id) });
  assert.equal(job.caseCount, 500); assert.equal(job.total, 1000); assert.equal(job.completed, 1000);
  assert.equal(f.state.tasks.length, 1000);
  assert.deepEqual(f.calls.map(c => c.profileId), [...Array(500).fill('gemma-local'), ...Array(500).fill('clef-local')]);
});

test('new selection is latest activity then numeric ID, includes open cases, and never depends on flags or re-evaluates saved cases', async () => {
  const f = fixture(12);
  f.state.conversations.forEach(c => { c.lastActivityAt = '2026-11-07T13:00:00Z'; });
  const old = f.state.conversations.find(c => c.id === '12');
  f.state.evaluations.push({ id: 'saved', conversationId: old.id, sourceHash: sourceFingerprint(old), createdAt: '2026-11-06T12:00:00Z', results: [{ variableId: f.state.catalog[0].id, status: 'evaluado', value: 1 }] });
  f.state.operationalRefs.push({ id: old.id, evaluationId: 'saved' });
  old.messages[0].text = 'Cambió después de guardar una evaluación.';
  f.state.conversations.find(c => c.id === '4').lastActivityAt = '2026-11-07T14:00:00Z';
  const job = await runEvaluationBatch(f.store, f.registry, { ...dualOptions, max: 3, pendingOnly: true, refreshChanged: false, includeOpen: true });
  assert.deepEqual(job.conversationIds, ['4', '11', '10']);
  assert.ok(!f.calls.some(c => c.conversationId === '12'));
  const refreshed = await runEvaluationBatch(f.store, f.registry, { max: 1, conversationIds: ['12'], pendingOnly: true, refreshChanged: true, includeOpen: true });
  assert.deepEqual(refreshed.conversationIds, ['12']);
});

test('partial Gemma results do not block the Clef phase; explicit resume retries only missing variables', async () => {
  let repaired = false;
  const f = fixture(3, ({ id, conversation, variables, result }) => {
    if (!repaired && id === 'gemma-local' && conversation.id === '2') return result(id, variables.filter(v => v.id === f.state.catalog[0].id));
    return result(id, variables);
  });
  const job = await runEvaluationBatch(f.store, f.registry, { ...dualOptions, max: 3 });
  assert.equal(job.status, 'partial'); assert.equal(job.completed, 5); assert.equal(job.partial, 1);
  const conversation = f.state.conversations.find(c => c.id === '2');
  assert.equal(conversationView(f.state, conversation).evaluationStatus, 'partial');
  assert.deepEqual(f.calls.map(c => c.profileId), [...Array(4).fill('gemma-local'), ...Array(3).fill('clef-local')]);
  assert.deepEqual(f.calls[2].variables, [f.state.catalog[1].id]);
  repaired = true;
  const savedTasks = f.state.tasks.map(t => t.id);
  await (await resumeEvaluationBatch(f.store, f.registry, job.id)).completion;
  assert.deepEqual(f.state.tasks.map(t => t.id), savedTasks);
  assert.equal(f.state.jobs[0].status, 'completed');
  assert.equal(conversationView(f.state, conversation).evaluationStatus, 'evaluated', 'The completed retry supersedes the anchor partial status without replacing its identity');
  assert.equal(f.calls.length, 8);
  assert.deepEqual(f.calls.at(-1), { profileId: 'gemma-local', conversationId: '2', variables: [f.state.catalog[1].id] });
});

test('idempotency reuses an active dual batch and the running guard rejects a second run', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(2, async ({ id, variables, result }) => { entered.resolve(); await gate.promise; return result(id, variables); });
  const options = { ...dualOptions, max: 2, idempotencyKey: randomUUID() };
  const first = await startEvaluationBatch(f.store, f.registry, options);
  await entered.promise;
  const duplicate = await startEvaluationBatch(f.store, f.registry, options);
  assert.equal(duplicate.job.id, first.job.id);
  assert.equal(duplicate.completion, first.completion);
  await assert.rejects(startEvaluationBatch(f.store, f.registry, { ...options, max: 1 }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(startEvaluationBatch(f.store, f.registry, { ...options, idempotencyKey: randomUUID() }), { code: 'EVALUATION_RUNNING' });
  assert.deepEqual(evaluationModelProgress(f.state, first.job).map(p => [p.running, p.pending]), [[1, 1], [0, 2]]);
  gate.resolve(); await first.completion;
  assert.equal(f.calls.length, 4); assert.equal(f.state.jobs.length, 1);
});

for (const withCode of [false, true]) test(`a primary context limit preserves independent Clef results without automatic flags; code placeholder=${withCode}`, async () => {
  const f = fixture(1, ({ id, variables, result }) => {
    if (id === 'gemma-local') throw new AppError(422, 'Límite sintético de entrada.', 'INPUT_CAPACITY_EXCEEDED');
    const answer = result(id, variables); answer.results.forEach(r => { r.value = 1; }); return answer;
  });
  if (withCode) {
    const metric = createState(false).catalog.find(v => v.id === 'num_mensajes_cliente');
    f.state.catalog.push(metric);
    f.state.catalogVersions.push({ id: `${metric.id}:${metric.version}`, itemId: metric.id, version: metric.version, snapshot: structuredClone(metric) });
  }
  const job = await runEvaluationBatch(f.store, f.registry, { ...dualOptions, max: 1 });
  const view = conversationView(f.state, f.state.conversations[0], undefined, true);
  assert.equal(job.status, 'partial');
  assert.deepEqual(f.calls.map(c => c.profileId), modelIds, 'A context limit is not retried');
  assert.equal(f.state.evaluations.length, withCode ? 2 : 1);
  assert.equal(f.state.operationalRefs.length, 1);
  assert.equal(f.state.operationalRefs[0].evaluationId, f.state.evaluations[0].id, 'Keep the first saved anchor, even if partial');
  assert.equal(view.evaluated, true); assert.equal(view.evaluationStatus, 'partial');
  assert.equal(view.evaluation.usedFallback, false);
  assert.deepEqual(view.evaluation.modelReviews.map(r => r.status), [withCode ? 'partial' : 'failed', 'completed']);
  assert.deepEqual(view.marks, []);
  const comparison = view.variables.find(v => v.type === 'Flag').result.comparison;
  assert.equal(comparison.detections, 1); assert.equal(comparison.agreement, 'incomplete');
  assert.equal(comparison.contingencyLabel, null);
  assert.ok(f.state.evaluations.every(e => !e.usedFallback && !e.contingencyFor));
});

test('a dual result never replaces the reference of a newer operational job', async () => {
  let inserted = false;
  const f = fixture(1, ({ id, conversation, variables, result, state }) => {
    if (!inserted) {
      inserted = true;
      state.jobs.push({ id: 'newer-job', purpose: 'operational', status: 'completed', createdAt: '2099-01-01T00:00:00Z', conversationIds: [conversation.id] });
      state.operationalRefs.push({ id: conversation.id, evaluationId: 'newer-evaluation' });
    }
    return result(id, variables);
  });
  const job = await runEvaluationBatch(f.store, f.registry, { ...dualOptions, max: 1 });
  assert.equal(job.completed, 2);
  assert.deepEqual(f.state.operationalRefs, [{ id: '1', evaluationId: 'newer-evaluation' }]);
});

test('API permits 100 local-dual cases and exposes actual model phase progress without changing policy', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(100, async ({ id, variables, result }) => { entered.resolve(); await gate.promise; return result(id, variables); });
  const { get, post } = authenticatedApp(f);
  const initial = (await get('/evaluations').expect(200)).body;
  assert.deepEqual(initial.limits, { manual: 100, comparison: 20, daily: 100 });
  assert.equal(initial.localDualAvailable, true); assert.equal(initial.localDualReady, true);
  for (const body of [ { scope: 'new', max: 101 }, { scope: 'new', max: 0 }, { scope: 'new', max: 1.5 },
    { scope: 'new', max: 500, largeBatch: true, maintenanceId: 'bypass' }, { scope: 'new', modelIds },
    { scope: 'new', executionOrder: 'model-first' }, { scope: 'new', reviewMode: 'other' } ]) await post(body).expect(422);
  const key = randomUUID();
  const response = await post({ scope: 'new', max: 100, reviewMode: 'local-dual', idempotencyKey: key }).expect(202);
  await entered.promise;
  assert.equal(response.body.job.caseCount, 100); assert.equal(response.body.job.executionOrder, 'model-first');
  const progress = (await get('/evaluations').expect(200)).body.jobs[0].modelProgress;
  assert.deepEqual(progress.map(p => [p.profileId, p.total, p.running, p.pending]), [['gemma-local', 100, 1, 99], ['clef-local', 100, 0, 100]]);
  const duplicate = await post({ scope: 'new', max: 100, reviewMode: 'local-dual', idempotencyKey: key }).expect(202);
  assert.equal(duplicate.body.job.id, response.body.job.id);
  await post({ scope: 'new', max: 1, reviewMode: 'local-dual' }).expect(409);
  const completion = (await startEvaluationBatch(f.store, f.registry, { pendingOnly: true, from: undefined, to: undefined,
    max: 100, idempotencyKey: key, author: undefined, ...dualOptions })).completion;
  gate.resolve(); await completion;
  assert.equal(f.state.jobs.length, 1); assert.equal(f.state.settings.aiPolicy.mode, 'single');
});

test('local dual readiness rejects a disabled or duplicate model; authorization and maintenance remain enforced', async () => {
  const f = fixture();
  const admin = authenticatedApp(f);
  const supervisor = authenticatedApp(f, 'supervisor');
  await supervisor.post({ scope: 'new', reviewMode: 'local-dual' }).expect(403);
  f.registry.profiles[1].enabled = false;
  assert.equal((await admin.get('/evaluations').expect(200)).body.localDualAvailable, false);
  await admin.post({ scope: 'new', reviewMode: 'local-dual' }).expect(409);
  f.registry.profiles[1].enabled = true;
  f.registry.profiles[1].model = f.registry.profiles[0].model;
  assert.equal((await admin.get('/evaluations').expect(200)).body.localDualAvailable, false);
  await admin.post({ scope: 'new', reviewMode: 'local-dual' }).expect(409);
  f.registry.profiles[1].model = 'clef-local';
  f.state.settings.evaluationMaintenance = 'synthetic-maintenance';
  const blocked = await admin.post({ scope: 'new', reviewMode: 'local-dual' }).expect(409);
  assert.equal(blocked.body.error.code, 'EVALUATION_MAINTENANCE');
  assert.equal(f.state.jobs.length, 0);
});
