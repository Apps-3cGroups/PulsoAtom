import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogV5 } from '../src/catalog-v5.js';
import { ModelRegistry } from '../src/model-registry.js';
import { catalogReferences, evaluationContext, digest } from '../src/evaluation-context.js';
import { RECOVERY_ID, RECOVERY_JOBS, recoveryPlan } from '../src/gemma-incident-recovery.js';
import { COMPLETION_ID, COMPLETION_KEYS, COMPLETION_MODELS, makeCompletionPlan, prepareCompletion,
  prepareThursdayPriority, deferTuesdayForThursday, thursdayPriorityReleased, thursdayPriorityReady,
  assertDeferredThursday, claimDeferredTuesday, completionStatus, completionRetry, assertCompletionMutation } from '../src/tuesday-wednesday-completion.js';
import { prepareThursdayHandoff, assertThursdayRequest } from '../src/thursday-handoff.js';
import { dailyActivityRequest } from '../src/daily-activity.js';
const fail = (fn, code) => assert.throws(fn, error => error.code === code);
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

async function priorityFixture(mode = 'automatic_before_noon') {
  const f = prepared();
  const store = { transaction: async fn => fn(f.state) };
  await prepareThursdayHandoff(store, f.registry, f.plan, { expectedVersion: 17, expectedScopeHash: f.plan.integrityHash,
    concurrency: 1, now: new Date('2026-11-13T02:00:00Z') });
  prepareThursdayPriority(f.state, f.registry, f.plan, { expectedVersion: 18, resumeTuesday: mode, now: new Date('2026-11-13T03:00:00Z') });
  return f;
}
function completeWednesday(f) {
  const ids = f.plan.wednesday.map(c => c.id), job = { id: 'wednesday-job', idempotencyKey: COMPLETION_KEYS.wednesday,
    purpose: 'operational', mode: 'dual', maintenanceId: RECOVERY_ID, status: 'completed', concurrency: 1,
    conversationIds: ids, modelProfiles: structuredClone(f.plan.profiles) };
  f.state.jobs.push(job);
  for (const c of f.plan.wednesday) for (const profile of f.plan.profiles) f.state.tasks.push({
    id: `wed-${c.id}-${profile.id}`, jobId: job.id, conversationId: c.id, profile: structuredClone(profile),
    status: 'completed', error: null, context: Object.fromEntries(['sourceHash','catalogHash','promptHash','promptVersion','rulesVersion'].map(k => [k,c[k]])) });
  for (const expected of completionRetry(f.plan)) Object.assign(f.state.tasks.find(t => t.id === expected.taskId), { status: 'completed', error: null });
}
const yieldNow = new Date('2026-11-13T06:30:00Z');

test('priority authorization is scoped, version guarded, idempotent and leaves settings/results untouched', async () => {
  const f = prepared();
  await prepareThursdayHandoff({ transaction: async fn => fn(f.state) }, f.registry, f.plan,
    { expectedVersion: 17, expectedScopeHash: f.plan.integrityHash, concurrency: 1, now: new Date('2026-11-13T02:00:00Z') });
  const before = structuredClone(f.state);
  fail(() => prepareThursdayPriority(f.state, f.registry, f.plan, { expectedVersion: 17, resumeTuesday: 'manual' }), 'VERSION_CONFLICT');
  fail(() => prepareThursdayPriority(f.state, f.registry, f.plan, { expectedVersion: 18, resumeTuesday: 'other' }), 'INVALID_TUESDAY_RESUME');
  assert.deepEqual(f.state, before);
  const request = { expectedVersion: 18, resumeTuesday: 'automatic_before_noon', now: new Date('2026-11-13T03:00:00Z') };
  const result = prepareThursdayPriority(f.state, f.registry, f.plan, request);
  assert.equal(result.priorityVersion, 1); assert.equal(result.deadline, '2026-11-13T18:00:00.000Z');
  assertCompletionMutation(before, f.state, f.plan);
  assert.equal(f.state.settings.version, 18);
  for (const key of ['jobs','tasks','evaluations','operationalRefs']) assert.deepEqual(f.state[key], before[key]);
  const approved = structuredClone(f.state);
  assert.equal(prepareThursdayPriority(f.state, f.registry, f.plan, request).alreadyPrepared, true);
  assert.deepEqual(f.state, approved);
  fail(() => prepareThursdayPriority(f.state, f.registry, f.plan, { ...request, resumeTuesday: 'manual' }), 'PRIORITY_CHANGED');
  assert.deepEqual(f.state, approved);
});

test('release requires all 86 Wednesday tasks and both retry tasks, never marks Tuesday complete', async () => {
  const f = await priorityFixture();
  fail(() => deferTuesdayForThursday(f.state, f.registry, f.plan, yieldNow), 'WEDNESDAY_NOT_FINISHED');
  completeWednesday(f);
  const retry = f.state.tasks.find(t => t.id === completionRetry(f.plan)[0].taskId);
  retry.status = 'partial';
  fail(() => deferTuesdayForThursday(f.state, f.registry, f.plan, yieldNow), 'WEDNESDAY_NOT_FINISHED');
  retry.status = 'completed';
  const before = structuredClone(f.state), result = deferTuesdayForThursday(f.state, f.registry, f.plan, yieldNow);
  assert.equal(result.status, 'waiting_thursday'); assert.equal(f.state.settings.evaluationMaintenance, null);
  assertCompletionMutation(before, f.state, f.plan);
  for (const key of ['jobs','tasks','evaluations','operationalRefs']) assert.deepEqual(f.state[key], before[key]);
  assert.equal(thursdayPriorityReleased(f.state.settings), true); assert.equal(thursdayPriorityReady(f.state), true);
  assert.equal(assertDeferredThursday(f.state, f.registry, f.plan), yieldNow.toISOString());
  const status = completionStatus(f.state, f.plan, { status: 'running', phase: 'wednesday' }, false);
  assert.equal(status.status, 'waiting_thursday'); assert.equal(status.phase, 'waiting_thursday');
  assert.equal(status.wednesday.completed, 43); assert.equal(status.tuesday.completed, 2);
  assert.equal(status.completedModelTasks, 88); assert.equal(status.totalModelTasks, 422);
  assert.equal(status.preservedCompletedTasks, 725);
  assert.equal(deferTuesdayForThursday(f.state, f.registry, f.plan, yieldNow).alreadyDeferred, true);
  assert.doesNotThrow(() => assertThursdayRequest(f.state, f.registry, dailyActivityRequest(f.state.settings, '2026-11-13')));
});

test('missing tasks, changed proof, handoff scope, country cap and excluded records fail closed', async () => {
  const f = await priorityFixture(); completeWednesday(f); deferTuesdayForThursday(f.state, f.registry, f.plan, yieldNow);
  for (const mutate of [
    s => s.tasks.pop(),
    s => { s.tasks.at(-1).status = 'partial'; },
    s => { s.settings.tuesdayWednesdayCompletion.priority.handoffRelease.retryTaskProof[0].hash = '0'.repeat(64); },
    s => { s.settings.thursdayHandoff.limitPerCountry = 201; },
    s => { s.settings.thursdayHandoff.concurrency = 2; },
    s => { s.settings.thursdayHandoff.scopeHash = 'f'.repeat(64); },
    s => { s.settings.tuesdayWednesdayCompletion.priority.completionScopeHash = 'e'.repeat(64); },
  ]) {
    const altered = structuredClone(f.state); mutate(altered);
    assert.equal(thursdayPriorityReady(altered), false);
    fail(() => assertDeferredThursday(altered, f.registry, f.plan), 'THURSDAY_PRIORITY_CHANGED');
    fail(() => assertThursdayRequest(altered, f.registry, dailyActivityRequest(altered.settings, '2026-11-13')), 'HANDOFF_NOT_READY');
  }
  const excluded = structuredClone(f.state); excluded.tasks.find(t => t.id === f.plan.excluded[0].taskId).status = 'completed';
  fail(() => assertDeferredThursday(excluded, f.registry, f.plan), 'EXCLUDED_RECORD_CHANGED');
});

test('release and Tuesday claim refuse active jobs without clearing maintenance or changing tasks', async () => {
  const f = await priorityFixture(); completeWednesday(f);
  f.state.jobs.push({ id: 'foreign', status: 'running' });
  const before = structuredClone(f.state);
  fail(() => deferTuesdayForThursday(f.state, f.registry, f.plan, yieldNow), 'OTHER_JOB_RUNNING');
  assert.deepEqual(f.state, before);
  f.state.jobs.pop(); deferTuesdayForThursday(f.state, f.registry, f.plan, yieldNow);
  f.state.settings.thursdayHandoff.status = 'caught_up'; f.state.jobs.push({ id: 'thursday-running', status: 'running' });
  const waiting = structuredClone(f.state);
  fail(() => claimDeferredTuesday(f.state, f.registry, f.plan, new Date('2026-11-13T10:00:00Z')), 'EVALUATION_RUNNING');
  assert.deepEqual(f.state, waiting);
});

test('Tuesday auto claim requires Thursday caught up and time before noon, then can yield again', async () => {
  const f = await priorityFixture(); completeWednesday(f); deferTuesdayForThursday(f.state, f.registry, f.plan, yieldNow);
  fail(() => claimDeferredTuesday(f.state, f.registry, f.plan, new Date('2026-11-13T10:00:00Z')), 'THURSDAY_NOT_CAUGHT_UP');
  f.state.settings.thursdayHandoff.status = 'caught_up';
  const before = structuredClone(f.state);
  fail(() => claimDeferredTuesday(f.state, f.registry, f.plan, new Date('2026-11-13T18:00:00Z')), 'TUESDAY_DEADLINE_REACHED');
  assert.deepEqual(f.state, before);
  claimDeferredTuesday(f.state, f.registry, f.plan, new Date('2026-11-13T17:59:00Z'));
  assert.equal(f.state.settings.evaluationMaintenance, RECOVERY_ID);
  assert.equal(f.state.settings.tuesdayWednesdayCompletion.status, 'prepared');
  assert.equal(thursdayPriorityReleased(f.state.settings), false);
  assertCompletionMutation(before, f.state, f.plan);
  const claimed = structuredClone(f.state);
  deferTuesdayForThursday(f.state, f.registry, f.plan, new Date('2026-11-13T18:01:00Z'));
  assertCompletionMutation(claimed, f.state, f.plan);
  assert.equal(thursdayPriorityReady(f.state), true);
  assert.equal(f.state.settings.tuesdayWednesdayCompletion.priority.lastTuesdayResumeAt, '2026-11-13T17:59:00.000Z');
});

test('manual mode never claims Tuesday automatically', async () => {
  const f = await priorityFixture('manual'); completeWednesday(f); deferTuesdayForThursday(f.state, f.registry, f.plan, yieldNow);
  f.state.settings.thursdayHandoff.status = 'caught_up';
  const before = structuredClone(f.state);
  fail(() => claimDeferredTuesday(f.state, f.registry, f.plan, new Date('2026-11-13T10:00:00Z')), 'TUESDAY_MANUAL_REVIEW_REQUIRED');
  assert.deepEqual(f.state, before);
});

test('checkpoint task proof survives database JSON key ordering without accepting changed values', async () => {
  const f = await priorityFixture(); completeWednesday(f); deferTuesdayForThursday(f.state, f.registry, f.plan, yieldNow);
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reorder(value[key])])) : value;
  const reordered = reorder(f.state);
  assert.equal(thursdayPriorityReady(reordered), true);
  reordered.tasks.find(t => t.jobId === 'wednesday-job').context.sourceHash = 'changed';
  assert.equal(thursdayPriorityReady(reordered), false);
});

test('a failed Tuesday slice remains deferred without blocking Thursday or leaking diagnostics', async () => {
  const f = await priorityFixture(); completeWednesday(f); deferTuesdayForThursday(f.state, f.registry, f.plan, yieldNow);
  f.state.settings.thursdayHandoff.status = 'caught_up';
  f.state.settings.tuesdayWednesdayCompletion.priority.tuesdayBlocked = {
    code: 'SOURCE_CHANGED', at: '2026-11-13T10:00:00.000Z', message: 'PRIVATE_TRANSCRIPT_PROVIDER_ERROR',
  };
  const before = structuredClone(f.state);
  fail(() => claimDeferredTuesday(f.state, f.registry, f.plan, new Date('2026-11-13T11:00:00Z')), 'TUESDAY_REQUIRES_INTERVENTION');
  assert.deepEqual(f.state, before); assert.equal(thursdayPriorityReady(f.state), true);
  assert.doesNotThrow(() => assertThursdayRequest(f.state, f.registry, dailyActivityRequest(f.state.settings, '2026-11-13')));
  const status = completionStatus(f.state, f.plan);
  assert.equal(status.tuesdayDeferredBlocked, true); assert.equal(status.tuesdayDeferredErrorCode, 'SOURCE_CHANGED');
  assert.equal(status.tuesdayDeferredErrorAt, '2026-11-13T10:00:00.000Z');
  assert.deepEqual(status.priority, { order: 'wednesday-thursday-tuesday', resumeTuesday: 'automatic_before_noon', deadline: '2026-11-13T18:00:00.000Z' });
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_|wednesdayTaskProof|retryTaskProof/);
});
