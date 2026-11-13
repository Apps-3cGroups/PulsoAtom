import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogV5 } from '../src/catalog-v5.js';
import { ModelRegistry } from '../src/model-registry.js';
import { catalogReferences, evaluationContext } from '../src/evaluation-context.js';
import { RECOVERY_ID, RECOVERY_JOBS, recoveryPlan } from '../src/gemma-incident-recovery.js';
import { COMPLETION_ID, COMPLETION_KEYS, COMPLETION_MODELS, makeCompletionPlan, prepareCompletion,
  assertCompletionMutation, completionRetry, completionStatus } from '../src/tuesday-wednesday-completion.js';
import { prepareThursdayHandoff } from '../src/thursday-handoff.js';
import { parseCompletionArguments, configureThursdayPriority, deferredThursdayManifest,
  executeCompletion, executeCompletionWorker, launchDeferredTuesday, executeTuesdaySlice } from '../scripts/complete-tuesday-wednesday.js';

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

async function priorityFixture(resumeTuesday = 'manual') {
  const f = prepared();
  await prepareThursdayHandoff({ transaction: fn => fn(f.state) }, f.registry, f.plan, {
    expectedVersion: f.state.settings.version, expectedScopeHash: f.plan.integrityHash,
    concurrency: 1, now: new Date('2026-11-13T05:00:00Z'),
  });
  f.state.settings.version = 21;
  const tuesday = { id: 'existing-tuesday', idempotencyKey: COMPLETION_KEYS.tuesday, purpose: 'operational',
    mode: 'dual', maintenanceId: RECOVERY_ID, conversationIds: f.plan.tuesday.map(c => c.id),
    modelProfiles: f.plan.profiles, status: 'interrupted', concurrency: 1 };
  f.state.jobs.push(tuesday);
  f.state.tasks.push(...tuesday.conversationIds.flatMap((id, index) => f.plan.profiles.map(profile => ({
    id: `${id}-${profile.id}`, jobId: tuesday.id, conversationId: id, profile,
    status: index < 3 ? 'completed' : index === 3 ? 'partial' : 'pending',
    profileStates: { [profile.id]: { results: index <= 3 ? [{ variableId: flagIds[0], status: 'evaluado', value: 0, reason: 'PRIVATE_RETAINED_ANSWER' }] : [] } },
  }))));
  const store = memory(f), manifest = { id: COMPLETION_ID, plan: f.plan, status: 'running', phase: 'wednesday', pid: 123 };
  await configureThursdayPriority(store, f.registry, manifest, {
    expectedVersion: 21, resumeTuesday, now: new Date('2026-11-13T05:10:00Z'),
  }, { inspectWorker: async () => ({ alive: false }) });
  return { ...f, store, manifest, tuesday };
}

function phaseOperations(f, calls) {
  return {
    async resumeBatch(guarded, _registry, jobId, options) {
      calls.push(['resume', jobId]);
      assert.ok(RECOVERY_JOBS.includes(jobId), 'Tuesday must not resume before Thursday');
      await guarded.transaction(state => {
        for (const retry of completionRetry(f.plan).filter(item => item.jobId === jobId)) {
          assert.ok(options.conversationIds.includes(retry.id));
          Object.assign(state.tasks.find(task => task.id === retry.taskId), { status: 'completed', error: null });
        }
        state.jobs.find(job => job.id === jobId).status = 'partial';
      });
      return { job: { id: jobId }, completion: Promise.resolve() };
    },
    async startBatch(guarded, _registry, options) {
      calls.push(['start', options.idempotencyKey]);
      assert.equal(options.idempotencyKey, COMPLETION_KEYS.wednesday);
      assert.equal(options.conversationIds.length, 43);
      const job = { id: 'new-wednesday', idempotencyKey: options.idempotencyKey, purpose: 'operational', mode: 'dual',
        maintenanceId: RECOVERY_ID, conversationIds: options.conversationIds, modelProfiles: f.plan.profiles, status: 'completed', concurrency: 1 };
      await guarded.transaction(state => {
        state.jobs.push(job);
        state.tasks.push(...options.conversationIds.flatMap(id => f.plan.profiles.map(profile => ({
          id: `${id}-${profile.id}`, jobId: job.id, conversationId: id, profile, status: 'completed',
        }))));
      });
      return { job, completion: Promise.resolve() };
    },
  };
}

test('priority CLI requires exact version and explicit Tuesday resumption policy', () => {
  for (const resumeTuesday of ['manual', 'automatic_before_noon']) {
    assert.deepEqual(parseCompletionArguments(['--prioritize-thursday', '--expected-version', '21', '--resume-tuesday', resumeTuesday]),
      { mode: '--prioritize-thursday', expectedVersion: 21, resumeTuesday });
  }
  for (const args of [[], ['--prioritize-thursday'], ['--prioritize-thursday', '--expected-version', '21\n', '--resume-tuesday', 'manual'],
    ['--prioritize-thursday', '--expected-version', '21', '--resume-tuesday', 'always'],
    ['--prioritize-thursday', '--expected-version', '9007199254740992', '--resume-tuesday', 'manual']]) {
    assert.throws(() => parseCompletionArguments(args), error => error.code === 'INVALID_ARGUMENTS');
  }
  assert.deepEqual(parseCompletionArguments(['--start', '--concurrency=1']), { mode: '--start', concurrency: 1 });
  assert.deepEqual(parseCompletionArguments(['--status']), { mode: '--status', concurrency: 1 });
  assert.deepEqual(parseCompletionArguments(['--resume-tuesday']), { mode: '--resume-tuesday', concurrency: 1 });
  assert.throws(() => parseCompletionArguments(['--resume-tuesday', '--concurrency=2']), error => error.code === 'INVALID_ARGUMENTS');
});

test('priority configuration rejects a live frozen worker without changing any state', async () => {
  const f = await priorityFixture(), before = await f.store.read();
  await assert.rejects(configureThursdayPriority(f.store, f.registry, f.manifest, {
    expectedVersion: 21, resumeTuesday: 'automatic_before_noon',
  }, { inspectWorker: async () => ({ alive: true }) }), error => error.code === 'COMPLETION_WORKER_RUNNING');
  assert.deepEqual(await f.store.read(), before);
  assert.equal(f.calls.length, 0);
});

test('worker releases Thursday after retries and Wednesday, keeps Tuesday answers, and never finalizes the full cohort', async () => {
  const f = await priorityFixture(), calls = [], writes = [], before = await f.store.read();
  const result = await executeCompletionWorker(f.store, f.registry, f.manifest, {
    execute: (store, registry, plan, options) => executeCompletion(store, registry, plan, { ...options, ...phaseOperations(f, calls) }),
    persist: async (_file, manifest) => writes.push(structuredClone(manifest)),
    writeCompleted: async () => assert.fail('The 212-conversation completion must not be finalized'),
  });
  const after = await f.store.read();
  assert.deepEqual(calls, [['resume', RECOVERY_JOBS[1]], ['start', COMPLETION_KEYS.wednesday]]);
  assert.equal(result.status, 'waiting_thursday'); assert.equal(result.totalConversations, 212);
  assert.equal(result.totalModelTasks, 422); assert.equal(result.completedModelTasks, 94);
  assert.equal(result.remainingModelTasks, 328); assert.equal(result.wednesday.completed, 43);
  assert.equal(result.tuesday.completed, 5); assert.equal(result.preservedCompletedTasks, 725);
  assert.equal(result.finishedAt, null); assert.equal(result.maintenanceActive, false);
  assert.equal(after.settings.tuesdayWednesdayCompletion.status, 'waiting_thursday');
  assert.equal(after.settings.evaluationMaintenance, null);
  assert.equal(writes.at(-1).status, 'waiting_thursday'); assert.equal(writes.at(-1).phase, 'waiting_thursday');
  assert.deepEqual(after.tasks.filter(task => task.jobId === f.tuesday.id), before.tasks.filter(task => task.jobId === f.tuesday.id));
  assert.deepEqual(after.evaluations, before.evaluations);
  for (const task of before.tasks.filter(task => task.status === 'completed')) assert.deepEqual(after.tasks.find(row => row.id === task.id), task);
  assert.equal(f.calls.length, 0);
});

test('committed Thursday checkpoint reconciles a stale manifest after filesystem failure without reclaiming maintenance', async () => {
  const f = await priorityFixture(), calls = [];
  const stale = structuredClone(f.manifest);
  await assert.rejects(executeCompletionWorker(f.store, f.registry, f.manifest, {
    execute: (store, registry, plan, options) => executeCompletion(store, registry, plan, { ...options, ...phaseOperations(f, calls) }),
    persist: async (_file, manifest) => { if (manifest.status === 'waiting_thursday') throw new Error('synthetic filesystem failure'); },
    writeCompleted: async () => assert.fail('Must not mark completion after Thursday checkpoint'),
  }), /synthetic filesystem failure/);
  const before = await f.store.read();
  const reconciled = deferredThursdayManifest(before, f.registry, stale);
  assert.equal(stale.status, 'running'); assert.equal(reconciled.status, 'waiting_thursday');
  assert.equal(reconciled.phase, 'waiting_thursday'); assert.equal(reconciled.finishedAt, null);
  const status = completionStatus(before, f.plan, reconciled, false);
  assert.equal(status.completedModelTasks, 94); assert.equal(status.remainingModelTasks, 328);
  assert.equal(status.status, 'waiting_thursday'); assert.equal(status.maintenanceActive, false);
  assert.deepEqual(await f.store.read(), before);
});

async function automaticReadyFixture() {
  const f = await priorityFixture('automatic_before_noon');
  await executeCompletion(f.store, f.registry, f.plan, phaseOperations(f, []));
  f.state = await f.store.read();
  // The ordinary scheduler has independently caught up Thursday. A completed
  // Wednesday source later evolves; Tuesday must not reread that conversation.
  f.state.settings.thursdayHandoff.status = 'caught_up';
  f.state.conversations.find(c => c.id === f.plan.wednesday[0].id).messages[0].text = 'PRIVATE_NEW_SOURCE';
  f.store = memory(f);
  f.manifest = deferredThursdayManifest(f.state, f.registry, f.manifest);
  return f;
}

test('automatic launcher checks live worker and fresh Thursday readiness before the locked claim', async () => {
  const f = await automaticReadyFixture(), before = await f.store.read(), launches = [], intents = [];
  const options = { inspectWorker: async () => ({ alive: false }), now: () => new Date('2026-11-13T15:00:00Z'),
    recordIntent: async manifest => intents.push(structuredClone(manifest)),
    launch: async manifest => { launches.push(structuredClone(manifest)); return { started: true }; } };
  const busy = await launchDeferredTuesday(f.store, f.registry, f.manifest, { ...options,
    inspectWorker: async () => ({ alive: true }), checkReadiness: async () => assert.fail('Live worker must not trigger another readiness/claim') });
  assert.equal(busy.alreadyStarted, true);
  const deferred = await launchDeferredTuesday(f.store, f.registry, f.manifest, { ...options,
    checkReadiness: async () => ({ ready: false, reason: 'THURSDAY_NOT_CAUGHT_UP' }) });
  assert.equal(deferred.started, false); assert.equal(launches.length, 0); assert.equal(intents.length, 0);
  assert.deepEqual(await f.store.read(), before);
  await launchDeferredTuesday(f.store, f.registry, f.manifest, { ...options, checkReadiness: async () => ({ ready: true }) });
  const after = await f.store.read();
  assert.equal(launches.length, 1); assert.equal(intents.length, 1); assert.equal(intents[0].mode, 'tuesday-slice');
  assert.equal(after.settings.evaluationMaintenance, RECOVERY_ID);
  assert.equal(after.settings.tuesdayWednesdayCompletion.concurrency, 1);
  assert.equal(after.settings.tuesdayWednesdayCompletion.status, 'prepared');
  assert.deepEqual(after.tasks, before.tasks); assert.deepEqual(after.evaluations, before.evaluations);
});

test('automatic slice resumes only one unfinished Tuesday conversation and yields Thursday again', async () => {
  const f = await automaticReadyFixture(), reads = [], calls = [];
  await launchDeferredTuesday(f.store, f.registry, f.manifest, { inspectWorker: async () => ({ alive: false }),
    now: () => new Date('2026-11-13T15:00:00Z'), checkReadiness: async () => ({ ready: true }), recordIntent: async () => {}, launch: async () => ({ started: true }) });
  const before = await f.store.read(), selected = f.plan.tuesday[3].id;
  const tracked = { ...f.store, async readWithConversations(options) {
    reads.push(options.conversationIds); return f.store.readWithConversations(options);
  } };
  const result = await executeCompletionWorker(tracked, f.registry, f.manifest, {
    execute: (store, registry, plan, options) => executeTuesdaySlice(store, registry, plan, { ...options,
      now: () => new Date('2026-11-13T15:01:00Z'),
      resumeBatch: async (guarded, _registry, jobId, options) => {
        calls.push(options.conversationIds); assert.equal(jobId, f.tuesday.id);
        await guarded.readWithConversations({ conversationIds: options.conversationIds });
        await guarded.transaction(state => {
          for (const task of state.tasks.filter(t => t.jobId === jobId && options.conversationIds.includes(t.conversationId))) task.status = 'completed';
          state.jobs.find(job => job.id === jobId).status = 'partial';
        });
        return { job: { id: jobId }, completion: Promise.resolve() };
      } }),
    persist: async () => {}, writeCompleted: async () => assert.fail('More Tuesday work remains'),
  });
  assert.deepEqual(calls, [[selected]]); assert.ok(reads.length > 0);
  assert.ok(reads.every(ids => ids.length === 1 && ids[0] === selected));
  assert.equal(result.status, 'waiting_thursday'); assert.equal(result.completedModelTasks, 96);
  assert.equal(result.remainingModelTasks, 326); assert.equal(result.maintenanceActive, false);
  const after = await f.store.read();
  assert.deepEqual(after.evaluations, before.evaluations);
  for (const task of before.tasks.filter(t => t.conversationId !== selected)) assert.deepEqual(after.tasks.find(t => t.id === task.id), task);
  assert.equal(f.calls.length, 0);
});

test('noon rejects a new claim and a claimed slice yields without invoking a model', async () => {
  const f = await automaticReadyFixture(), before = await f.store.read();
  const options = { inspectWorker: async () => ({ alive: false }), checkReadiness: async () => ({ ready: true }),
    recordIntent: async () => {}, launch: async () => ({ started: true }) };
  await assert.rejects(launchDeferredTuesday(f.store, f.registry, f.manifest, { ...options,
    now: () => new Date('2026-11-13T18:00:00Z') }), error => error.code === 'TUESDAY_DEADLINE_REACHED');
  assert.deepEqual(await f.store.read(), before);
  await launchDeferredTuesday(f.store, f.registry, f.manifest, { ...options, now: () => new Date('2026-11-13T17:59:59Z') });
  const result = await executeTuesdaySlice({ ...f.store,
    readWithConversations: async () => assert.fail('Expired slice must not read source messages') }, f.registry, f.plan, {
    now: () => new Date('2026-11-13T18:00:00Z'), resumeBatch: async () => assert.fail('Expired slice must not invoke a model'),
  });
  assert.equal(result.status, 'waiting_thursday');
  assert.equal((await f.store.read()).settings.evaluationMaintenance, null);
  assert.deepEqual((await f.store.read()).tasks, before.tasks);
});

test('failed Tuesday launch releases Thursday only when the child is proved dead and disables automatic retries', async () => {
  for (const childAlive of [false, true]) {
    const f = await automaticReadyFixture(); let inspections = 0;
    await assert.rejects(launchDeferredTuesday(f.store, f.registry, f.manifest, {
      inspectWorker: async () => ({ alive: ++inspections > 1 && childAlive }),
      checkReadiness: async () => ({ ready: true }), now: () => new Date('2026-11-13T15:00:00Z'),
      recordIntent: async () => {}, launch: async () => { throw Object.assign(new Error('PRIVATE_START_ERROR'), { code: 'SPAWN_FAILED' }); },
    }), error => error.code === 'SPAWN_FAILED');
    const after = await f.store.read(), c = after.settings.tuesdayWednesdayCompletion;
    assert.equal(after.settings.evaluationMaintenance, childAlive ? RECOVERY_ID : null);
    assert.equal(c.status, childAlive ? 'prepared' : 'waiting_thursday');
    if (!childAlive) {
      assert.deepEqual(c.priority.tuesdayBlocked, { code: 'SPAWN_FAILED', at: '2026-11-13T15:00:00.000Z' });
      assert.equal(JSON.stringify(completionStatus(after, f.plan, f.manifest)).includes('PRIVATE_START_ERROR'), false);
    } else assert.equal(c.priority.tuesdayBlocked, undefined);
  }
});

test('a superseded Tuesday slice preserves the guard, releases Thursday, and stops automatic retries', async () => {
  const f = await automaticReadyFixture();
  await launchDeferredTuesday(f.store, f.registry, f.manifest, { inspectWorker: async () => ({ alive: false }),
    now: () => new Date('2026-11-13T15:00:00Z'), checkReadiness: async () => ({ ready: true }), recordIntent: async () => {}, launch: async () => ({ started: true }) });
  const before = await f.store.read();
  await assert.rejects(executeCompletionWorker(f.store, f.registry, f.manifest, {
    execute: (store, registry, plan, options) => executeTuesdaySlice(store, registry, plan, { ...options,
      now: () => new Date('2026-11-13T15:01:00Z'),
      resumeBatch: async () => { throw Object.assign(new Error('PRIVATE_SUPERSEDED_DETAIL'), { code: 'SUPERSEDED_JOB' }); } }),
    persist: async () => {}, writeCompleted: async () => assert.fail('Superseded job cannot be finalized'),
  }), error => error.code === 'SUPERSEDED_JOB');
  const after = await f.store.read();
  assert.equal(after.settings.evaluationMaintenance, null);
  assert.equal(after.settings.tuesdayWednesdayCompletion.priority.tuesdayBlocked.code, 'SUPERSEDED_JOB');
  assert.equal(after.settings.tuesdayWednesdayCompletion.status, 'waiting_thursday');
  assert.deepEqual(after.tasks, before.tasks); assert.deepEqual(after.evaluations, before.evaluations);
  await assert.rejects(launchDeferredTuesday(f.store, f.registry, f.manifest, { inspectWorker: async () => ({ alive: false }),
    now: () => new Date('2026-11-13T15:02:00Z'), checkReadiness: async () => ({ ready: true }), recordIntent: async () => {}, launch: async () => assert.fail('Blocked slice cannot restart') }),
  error => error.code === 'TUESDAY_REQUIRES_INTERVENTION');
});

test('an uncertain in-flight Tuesday evaluation retains maintenance after an error', async () => {
  const f = await automaticReadyFixture();
  await launchDeferredTuesday(f.store, f.registry, f.manifest, { inspectWorker: async () => ({ alive: false }),
    now: () => new Date('2026-11-13T15:00:00Z'), checkReadiness: async () => ({ ready: true }), recordIntent: async () => {}, launch: async () => ({ started: true }) });
  await assert.rejects(executeCompletionWorker(f.store, f.registry, f.manifest, {
    execute: (store, registry, plan, options) => executeTuesdaySlice(store, registry, plan, { ...options,
      now: () => new Date('2026-11-13T15:01:00Z'),
      resumeBatch: async guarded => {
        await guarded.transaction(state => {
          state.jobs.find(job => job.id === f.tuesday.id).status = 'running';
          state.tasks.find(task => task.conversationId === f.plan.tuesday[3].id).status = 'running';
        });
        throw Object.assign(new Error('PRIVATE_UNKNOWN_PROVIDER_STATE'), { code: 'AI_TIMEOUT' });
      } }),
    persist: async () => {}, writeCompleted: async () => assert.fail('Uncertain work cannot be finalized'),
  }), error => error.code === 'AI_TIMEOUT');
  const after = await f.store.read();
  assert.equal(after.settings.evaluationMaintenance, RECOVERY_ID);
  assert.equal(after.settings.tuesdayWednesdayCompletion.priority.tuesdayBlocked, undefined);
});

test('the final Tuesday slice finalizes only after all 422 eligible tasks are complete', async () => {
  const f = await automaticReadyFixture();
  f.state = await f.store.read();
  const target = f.plan.tuesday.at(-1).id;
  for (const task of f.state.tasks.filter(task => task.jobId === f.tuesday.id)) task.status =
    task.conversationId === target && task.profile.id === 'gemma-local' ? 'pending' : 'completed';
  f.store = memory(f);
  await launchDeferredTuesday(f.store, f.registry, f.manifest, { inspectWorker: async () => ({ alive: false }),
    now: () => new Date('2026-11-13T15:00:00Z'), checkReadiness: async () => ({ ready: true }), recordIntent: async () => {}, launch: async () => ({ started: true }) });
  let finalizations = 0;
  const result = await executeCompletionWorker(f.store, f.registry, f.manifest, {
    execute: (store, registry, plan, options) => executeTuesdaySlice(store, registry, plan, { ...options,
      now: () => new Date('2026-11-13T15:01:00Z'), resumeBatch: async (guarded, _registry, jobId, options) => {
        assert.deepEqual(options.conversationIds, [target]);
        await guarded.transaction(state => {
          state.tasks.find(task => task.jobId === jobId && task.conversationId === target && task.profile.id === 'gemma-local').status = 'completed';
          state.jobs.find(job => job.id === jobId).status = 'completed';
        });
        return { job: { id: jobId }, completion: Promise.resolve() };
      } }),
    persist: async () => {}, writeCompleted: async () => { finalizations++; },
  });
  assert.equal(finalizations, 1); assert.equal(result.status, 'completed');
  assert.equal(result.completedModelTasks, 422); assert.equal(result.completedConversations, 212);
  assert.equal(result.remainingModelTasks, 0); assert.equal(result.excludedConversations, 1);
  assert.equal(result.preservedCompletedTasks, 725); assert.equal(result.maintenanceActive, false);
});

