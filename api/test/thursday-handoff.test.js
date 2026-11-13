import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogV5 } from '../src/catalog-v5.js';
import { ModelRegistry } from '../src/model-registry.js';
import { catalogReferences, evaluationContext, digest } from '../src/evaluation-context.js';
import { RECOVERY_ID, RECOVERY_JOBS, recoveryPlan } from '../src/gemma-incident-recovery.js';
import { COMPLETION_ID, COMPLETION_MODELS, makeCompletionPlan, prepareCompletion } from '../src/tuesday-wednesday-completion.js';
import { prepareThursdayHandoff, assertThursdayRequest, thursdayCoverage, reconcileThursdayHandoff, thursdayRunDate, THURSDAY_ID, THURSDAY_INGESTION } from '../src/thursday-handoff.js';
import { dailyActivityRequest } from '../src/daily-activity.js';
import { startEvaluationBatch } from '../src/evaluation-service.js';
import { runDailyTick } from '../src/daily-scheduler.js';
import { runOneOffTick } from '../src/one-off-scheduler.js';
import { fridayRun, activeReason, validateOneOffRequest, publicOneOffRuns } from '../src/one-off-evaluations.js';
import { completedOperationalPair } from '../src/daily-equivalence.js';
import { parseThursdayArguments } from '../scripts/prepare-thursday-handoff.js';
const reject = (promise, code) => assert.rejects(promise, e => e.code === code);
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
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

function memory(initial) {
  let current = structuredClone(initial), queue = Promise.resolve();
  const store = {
    ingestion: { batches: [{ id: 'hn', status: 'LISTO', countries: ['HN'] }, { id: 'pa', status: 'LISTO', countries: ['PA'] }] },
    beforeTransaction: null,
    async read() { await queue; return structuredClone(current); },
    async readWithConversations(options) { const state = await store.read();
      if (options?.conversationIds) state.conversations = state.conversations.filter(c => options.conversationIds.includes(c.id)); return state; },
    async readIngestionSnapshot() { return structuredClone(store.ingestion); },
    transaction(fn) { const run = queue.then(async () => { const draft = structuredClone(current);
      const hook = store.beforeTransaction; store.beforeTransaction = null; if (hook) hook(draft);
      const result = await fn(draft); current = draft; return structuredClone(result); }); queue = run.catch(() => {}); return run; },
  }; return store;
}
async function preparedHandoff() {
  const f = prepared();
  Object.assign(f.state.settings, { dailyStartDate: '2026-11-10', dailyCatchupRunDate: '2026-11-11', dailyConcurrency: 1,
    oneOffEvaluations: [structuredClone(fridayRun)] });
  const store = memory(f.state), result = await prepareThursdayHandoff(store, f.registry, f.plan, {
    expectedVersion: 17, expectedScopeHash: f.plan.integrityHash, concurrency: 1, now: new Date('2026-11-13T02:00:00Z') });
  return { ...f, store, result };
}
const thursday = (id, country = 'HN') => conversation(id, country, '2026-11-12T18:00:00Z', 'new');
async function runtime(conversations = [thursday('hn'), thursday('pa', 'PA')]) {
  const f = await preparedHandoff();
  await f.store.transaction(s => { s.settings.tuesdayWednesdayCompletion.status = 'completed'; s.settings.evaluationMaintenance = null;
    for (const key of ['jobs', 'tasks', 'evaluations', 'attempts', 'operationalRefs']) s[key] = [];
    s.conversations = conversations; }); return f;
}
async function request(store, date = '2026-11-13') { return dailyActivityRequest((await store.read()).settings, date); }
async function run(f) { const result = await startEvaluationBatch(f.store, f.registry, await request(f.store)); await result.completion; return result.job; }
async function drain(store) { for (let i = 0; i < 200; i++) { const s = await store.read(); if (!s.jobs.some(j => j.status === 'running')) return s; await new Promise(resolve => setTimeout(resolve, 1)); } assert.fail('synthetic job did not finish'); }

test('durable preparation preserves protected recovery and future cap, cancels only exceptional execution', async () => {
  const f = await preparedHandoff(), s = await f.store.read();
  for (const key of ['catalog', 'tasks', 'evaluations', 'jobs', 'operationalRefs']) assert.deepEqual(s[key], f.state[key]);
  assert.deepEqual(s.settings.tuesdayWednesdayCompletion, f.state.settings.tuesdayWednesdayCompletion);
  assert.equal(s.settings.evaluationMaintenance, RECOVERY_ID); assert.equal(s.settings.version, 18);
  assert.equal(s.settings.dailyLimitPerCountry, 200); assert.equal(s.settings.dailyConcurrency, 1);
  assert.equal(s.settings.dailyCatchupRunDate, undefined); assert.equal(s.settings.thursdayHandoff.limitPerCountry, null);
  assert.equal(s.settings.thursdayHandoff.approvedBy.includes('Mario'), true); assert.equal(s.settings.thursdayHandoffAudit.length, 1);
  assert.equal((await request(f.store)).executionOrder, 'conversation-first'); assert.equal((await request(f.store)).limitPerCountry, undefined);
  assert.equal((await request(f.store, '2026-11-14')).limitPerCountry, 200);
  const oneoff = s.settings.oneOffEvaluations[0]; assert.equal(oneoff.enabled, true); assert.equal(oneoff.executionSupersededBy, THURSDAY_ID);
  assert.equal(publicOneOffRuns(s)[0].statusLabel, 'Sustituida por la carga completa del jueves');
  assert.ok(activeReason({ ...thursday('closed'), completed: true, ingestionBatchId: 'new', ingestionStartedAt: '2026-11-13T08:00:00Z' }, s.settings, new Date('2026-11-13T17:00:00Z')));
  assert.equal(await runOneOffTick(f.store, f.registry, new Date('2026-11-13T17:00:00Z')), false);
  assert.throws(() => validateOneOffRequest(s, { oneOffRun: { id: oneoff.id }, oneOffClock: () => new Date('2026-11-13T17:00:00Z') }), e => e.code === 'ONE_OFF_CHANGED');
  assert.equal(f.calls.length, 0);
});
test('version, scope, pilot and protected data drift reject preparation without changes', async () => {
  for (const [change, code] of [[{ expectedVersion: 16 }, 'VERSION_CONFLICT'], [{ expectedScopeHash: '0'.repeat(64) }, 'COMPLETION_SCOPE_CHANGED'], [{ concurrency: 2 }, 'CONCURRENCY_PILOT_REQUIRED']]) {
    const f = prepared(), store = memory(f.state), before = await store.read();
    await reject(prepareThursdayHandoff(store, f.registry, f.plan, { expectedVersion: 17, expectedScopeHash: f.plan.integrityHash, ...change }), code);
    assert.deepEqual(await store.read(), before); assert.equal(f.calls.length, 0);
  }
  const f = prepared(); f.state.evaluations[0].results[0].value = 1; const store = memory(f.state), before = await store.read();
  await assert.rejects(prepareThursdayHandoff(store, f.registry, f.plan, { expectedVersion: 17, expectedScopeHash: f.plan.integrityHash }));
  assert.deepEqual(await store.read(), before);
});
test('handoff blocks before recovery ends and before Friday00:01 without launching Wednesday', async () => {
  const f = await preparedHandoff();
  assert.equal(await runDailyTick(f.store, f.registry, new Date('2026-11-13T08:00:00Z')), null);
  await f.store.transaction(s => { s.settings.evaluationMaintenance = null; });
  assert.equal(await runDailyTick(f.store, f.registry, new Date('2026-11-13T08:00:00Z')), null);
  await f.store.transaction(s => { s.settings.tuesdayWednesdayCompletion.status = 'completed'; });
  assert.equal(await runDailyTick(f.store, f.registry, new Date('2026-11-13T05:59:00Z')), null);
  assert.equal(f.calls.length, 0);
  assert.equal(thursdayRunDate((await f.store.read()).settings, new Date('2026-11-14T10:00:00Z')), '2026-11-13');
});
test('MySQL recursive object-key ordering preserves new handoff contract and old evaluation hashes', async () => {
  const f = await runtime(), before = await f.store.read(), state = sorted(before);
  assert.doesNotThrow(() => assertThursdayRequest(state, f.registry, dailyActivityRequest(state.settings, '2026-11-13')));
  assert.deepEqual(state.settings.thursdayHandoff.context, before.settings.thursdayHandoff.context);
  const altered = structuredClone(state); altered.settings.dailyCountries = ['HN'];
  assert.throws(() => assertThursdayRequest(altered, f.registry, dailyActivityRequest(altered.settings, '2026-11-13')), e => e.code === 'HANDOFF_NOT_READY');
});
test('Thursday selection has no200 country cap while ordinary future daily keeps it', async () => {
  const f = await runtime(Array.from({ length: 201 }, (_, i) => thursday(`hn-${i}`)));
  const execution = await startEvaluationBatch(f.store, f.registry, await request(f.store));
  assert.equal(execution.job.caseCount, 201); assert.equal(execution.job.total, 402); assert.equal(execution.job.limitPerCountry, null);
  await execution.completion; assert.equal(f.calls.length, 402);
  const s = await f.store.read(); assert.equal(s.settings.dailyLimitPerCountry, 200); assert.equal(s.jobs[0].status, 'completed');
});
test('actual dual evaluations are reused across jobs and new imports run incrementally', async () => {
  const f = await runtime();
  const historic = await startEvaluationBatch(f.store, f.registry, { modelIds: COMPLETION_MODELS, conversationIds: ['hn'], pendingOnly: false, includeOpen: true });
  await historic.completion;
  const first = await run(f); assert.deepEqual(first.conversationIds, ['pa']); assert.equal(f.calls.length, 4);
  assert.equal(await run(f), null); assert.equal(f.calls.length, 4);
  const coverage = thursdayCoverage(await f.store.read()); assert.equal(coverage.byCountry.HN.reusedCompleted, 1);
  await f.store.transaction(s => s.conversations.push(thursday('late-hn')));
  const later = await run(f); assert.deepEqual(later.conversationIds, ['late-hn']); assert.equal(f.calls.length, 6);
  assert.equal(await run(f), null);
});
test('changed ready source gets a new dual review once without modifying the original pair', async () => {
  const f = await runtime([thursday('change')]); const old = await run(f), before = await f.store.read();
  assert.equal(completedOperationalPair(before, before.conversations[0], before.settings.thursdayHandoff.profiles), true);
  await f.store.transaction(s => { s.conversations[0].messages.push({ id: 'later', actor: 'cliente', text: 'Nuevo mensaje', timestamp: '2026-11-12T19:00:00Z' }); });
  assert.equal(thursdayCoverage(await f.store.read()).byCountry.HN.unassignedConversations, 1);
  const updated = await run(f); assert.notEqual(updated.id, old.id); assert.deepEqual(updated.conversationIds, ['change']); assert.equal(f.calls.length, 4);
  assert.equal(await run(f), null);
  const after = await f.store.read(); for (const e of before.evaluations) assert.deepEqual(after.evaluations.find(x => x.id === e.id), e);
  assert.equal(thursdayCoverage(after).allReadyEvaluated, true);
});
test('partial same-version job does not loop and does not prevent a new conversation', async () => {
  const f = await runtime([thursday('partial')]); await run(f);
  await f.store.transaction(s => { s.tasks[0].status = 'partial'; s.tasks[0].error = { code: 'AI_INCOMPLETE' }; s.evaluations[0].partial = true; s.jobs[0].status = 'partial'; });
  for (let i = 0; i < 3; i++) assert.equal(await run(f), null);
  assert.equal(f.calls.length, 2); assert.equal(thursdayCoverage(await f.store.read()).byCountry.HN.remainingConversations, 1);
  await f.store.transaction(s => s.conversations.push(thursday('after-partial')));
  assert.deepEqual((await run(f)).conversationIds, ['after-partial']); assert.equal(f.calls.length, 4);
});
test('transaction race refuses a pair completed after candidate selection without extra model calls', async () => {
  const f = await runtime([thursday('race')]);
  const completed = await startEvaluationBatch(f.store, f.registry, { modelIds: COMPLETION_MODELS, conversationIds: ['race'], pendingOnly: false, includeOpen: true });
  await completed.completion; const saved = await f.store.read();
  await f.store.transaction(s => { for (const key of ['jobs', 'tasks', 'evaluations', 'attempts', 'operationalRefs']) s[key] = []; });
  f.store.beforeTransaction = draft => { for (const key of ['jobs', 'tasks', 'evaluations', 'attempts', 'operationalRefs']) draft[key] = structuredClone(saved[key]); };
  await reject(startEvaluationBatch(f.store, f.registry, await request(f.store)), 'DAILY_ALREADY_STARTED'); assert.equal(f.calls.length, 2);
});
test('caught-up remains open all Friday, accepts late imports, closes only after window and readiness', async () => {
  const f = await runtime(); await run(f);
  assert.equal(await reconcileThursdayHandoff(f.store, { now: new Date('2026-11-13T10:00:00Z') }), true);
  assert.equal((await f.store.read()).settings.thursdayHandoff.status, 'caught_up');
  await f.store.transaction(s => s.conversations.push(thursday('late-night')));
  const next = await runDailyTick(f.store, f.registry, new Date('2026-11-14T05:30:00Z'));
  assert.deepEqual(next.conversationIds, ['late-night']); await drain(f.store);
  f.store.ingestion.batches.push({ id: 'not-ready', countries: ['HN'], status: 'PROCESANDO' });
  assert.equal(await reconcileThursdayHandoff(f.store, { now: new Date('2026-11-14T07:00:00Z') }), false);
  f.store.ingestion.batches.pop();
  assert.equal(await reconcileThursdayHandoff(f.store, { now: new Date('2026-11-14T07:00:00Z') }), true);
  assert.equal((await f.store.read()).settings.thursdayHandoff.status, 'completed');
  assert.equal(thursdayRunDate((await f.store.read()).settings, new Date('2026-11-14T08:00:00Z')), null);
});
test('unknown or incomplete global ingestion never delays already-ready conversations', async () => {
  const f = await runtime([thursday('ready-hn')]); f.store.ingestion.batches = [{ id: 'processing', countries: [], status: 'PROCESANDO' }];
  const job = await runDailyTick(f.store, f.registry, new Date('2026-11-13T06:01:00Z')); assert.deepEqual(job.conversationIds, ['ready-hn']); await drain(f.store);
  assert.equal(await reconcileThursdayHandoff(f.store, { now: new Date('2026-11-14T07:00:00Z') }), false);
});
test('strict CLI accepts only inspect or exact version/scope/concurrency prepare arguments', () => {
  assert.deepEqual(parseThursdayArguments(['--inspect']), { mode: 'inspect' });
  assert.deepEqual(parseThursdayArguments(['--prepare', '--expected-version', '18', '--expected-scope-hash', 'a'.repeat(64), '--concurrency', '2']), { mode: 'prepare', expectedVersion: 18, expectedScopeHash: 'a'.repeat(64), concurrency: 2 });
  for (const args of [[], ['--prepare'], ['--inspect', '--prepare'], ['--prepare', '--expected-version', '0', '--expected-scope-hash', 'a'.repeat(64), '--concurrency', '2']]) assert.throws(() => parseThursdayArguments(args), e => e.code === 'INVALID_ARGUMENTS');
});

test('a legitimate prior maintenance is never cleared or bypassed by preparation', async () => {
  const f = fixture(); f.incident.plan.priorMaintenance = 'unrelated-maintenance';
  const plan = makeCompletionPlan(f.state, f.registry, f.incident); prepareCompletion(f.state, f.registry, plan, '2026-11-13T02:00:00Z');
  const store = memory(f.state), before = await store.read();
  await reject(prepareThursdayHandoff(store, f.registry, plan, { expectedVersion: 17, expectedScopeHash: plan.integrityHash }), 'HANDOFF_PRIOR_MAINTENANCE');
  assert.deepEqual(await store.read(), before);
});

test('a Thursday partial keeps its coverage open without blocking later ordinary daily activity', async () => {
  const f = await runtime([thursday('unresolved')]); await run(f);
  await f.store.transaction(s => { s.tasks[0].status = 'partial'; s.tasks[0].error = { code: 'AI_INCOMPLETE' }; s.evaluations[0].partial = true; s.jobs[0].status = 'partial';
    s.conversations.push(conversation('friday', 'HN', '2026-11-13T18:00:00Z', 'next')); });
  const next = await runDailyTick(f.store, f.registry, new Date('2026-11-14T07:00:00Z'));
  assert.deepEqual(next.conversationIds, ['friday']); assert.equal(next.scheduleDate, '2026-11-14'); assert.equal(next.limitPerCountry, 200);
  await drain(f.store); assert.equal(f.calls.length, 4);
  assert.notEqual((await f.store.read()).settings.thursdayHandoff.status, 'completed');
  await f.store.transaction(s => s.conversations.push(thursday('late-thursday')));
  const late = await runDailyTick(f.store, f.registry, new Date('2026-11-14T08:00:00Z'));
  assert.deepEqual(late.conversationIds, ['late-thursday']); assert.equal(late.dailyActivity.handoffId, THURSDAY_ID); await drain(f.store);
});
