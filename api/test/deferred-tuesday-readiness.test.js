import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeferredTuesdayReadiness, resumeDeferredTuesdayWhenReady } from '../src/deferred-tuesday-readiness.js';
import { COMPLETION_ID, COMPLETION_MODELS, THURSDAY_PRIORITY_ORDER, THURSDAY_PRIORITY_DEADLINE } from '../src/tuesday-wednesday-completion.js';

function fixture() {
  const hash = 'a'.repeat(64), scope = 'b'.repeat(64);
  const state = { settings: { evaluationMaintenance: null,
    tuesdayWednesdayCompletion: { id: COMPLETION_ID, status: 'waiting_thursday', concurrency: 1, priority: {
      version: 1, order: THURSDAY_PRIORITY_ORDER, resumeTuesday: 'automatic_before_noon', deadline: THURSDAY_PRIORITY_DEADLINE,
      approvedBy: 'Mario Cruz · prioridad lote 43, jueves y martes', approvedAt: '2026-11-13T06:00:00.000Z',
      completionScopeHash: scope, handoffScopeHash: hash, handoffRelease: { at: '2026-11-13T08:00:00.000Z', wednesdayJobId: 'wed',
        wednesdayTaskProof: Array.from({ length: 86 }, (_, i) => ({ id: `wed-${i}`, hash })),
        retryTaskProof: [{ id: 'retry-1', hash }, { id: 'retry-2', hash }] } } },
    thursdayHandoff: { id: 'thursday-2026-11-12-after-recovery', status: 'caught_up', completionId: COMPLETION_ID,
      completionScopeHash: scope, scopeHash: hash, limitPerCountry: 200, concurrency: 1,
      activityDate: '2026-11-12', runDate: '2026-11-13', notBefore: '2026-11-13T06:01:00.000Z',
      timezone: 'America/Tegucigalpa', countries: ['HN', 'PA'], modelIds: COMPLETION_MODELS } }, jobs: [] };
  const ingestion = { batches: [{ id: 'hn', countries: ['HN'], status: 'LISTO' }, { id: 'pa', countries: ['PA'], status: 'LISTO' }] };
  const current = { ingestionReady: true, allReadyEvaluated: true, errors: {}, byCountry: {
    HN: { eligibleConversations: 200, remainingConversations: 0, unavailableConversations: 0, outsideLimitConversations: 12 },
    PA: { eligibleConversations: 100, remainingConversations: 0, unavailableConversations: 0, outsideLimitConversations: 0 } } };
  const calls = [], store = {
    async readSchedulerState() { return structuredClone(state); },
    async readIngestionSnapshot(run) { calls.push(['ingestion', run]); return structuredClone(ingestion); },
    reader: { async readOverview(query, options) { calls.push(['overview', query, options]); return { conversations: [{ id: 'thu' }] }; } },
    async readWithConversations(options) { calls.push(['source', options]); return structuredClone(state); },
  };
  return { state, ingestion, current, calls, store, coverage: () => structuredClone(current) };
}
const time = new Date('2026-11-13T16:00:00.000Z');

test('Tuesday grants only a new slice after fresh Thursday coverage, ignoring records beyond country quota', async () => {
  const f = fixture();
  const result = await readDeferredTuesdayReadiness(f.store, time, { coverage: f.coverage });
  assert.equal(result.ready, true);
  assert.deepEqual(f.calls.find(c => c[0] === 'source')[1], { fresh: true, conversationIds: ['thu'] });
  let launched = 0;
  const operations = { readiness: (store, now) => readDeferredTuesdayReadiness(store, now, { coverage: f.coverage }), launch: async () => (++launched, { started: true }) };
  assert.deepEqual(await resumeDeferredTuesdayWhenReady(f.store, time, operations), { started: true });
  // New Thursday data takes priority over the next Tuesday conversation.
  f.current.byCountry.HN.remainingConversations = 1;
  f.current.allReadyEvaluated = false;
  assert.equal(await resumeDeferredTuesdayWhenReady(f.store, time, operations), null);
  assert.equal(launched, 1);
});

test('Tuesday waits for both imports, source availability, errors, exclusive ownership and the noon cutoff', async () => {
  for (const mutate of [
    f => { f.ingestion.batches[1].status = 'PROCESANDO'; },
    f => { f.ingestion.batches.pop(); },
    f => { f.current.errors.PROVIDER_ERROR = 1; },
    f => { f.current.byCountry.HN.unavailableConversations = 1; },
    f => { f.state.jobs.push({ status: 'running' }); },
    f => { f.state.settings.evaluationMaintenance = 'another-owner'; },
    f => { f.state.settings.tuesdayWednesdayCompletion.priority.resumeTuesday = 'manual'; },
    f => { f.state.settings.tuesdayWednesdayCompletion.priority.tuesdayBlocked = { code: 'SOURCE_CHANGED', at: time.toISOString() }; },
    f => { f.state.settings.thursdayHandoff.limitPerCountry = 201; },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal((await readDeferredTuesdayReadiness(f.store, time, { coverage: f.coverage })).ready, false);
  }
  const f = fixture();
  assert.equal((await readDeferredTuesdayReadiness(f.store, new Date(THURSDAY_PRIORITY_DEADLINE), { coverage: f.coverage })).reason, 'TUESDAY_DEADLINE_REACHED');
  assert.equal(f.calls.length, 0);
});

test('changes between the initial settings snapshot and fresh source read prevent launching Tuesday', async () => {
  const f = fixture(), read = f.store.readWithConversations;
  f.store.readWithConversations = async options => {
    const state = await read(options); state.jobs.push({ status: 'running' }); return state;
  };
  assert.equal((await readDeferredTuesdayReadiness(f.store, time, { coverage: f.coverage })).reason, 'EVALUATION_RUNNING');
});
