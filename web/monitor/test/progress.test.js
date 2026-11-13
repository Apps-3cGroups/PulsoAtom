import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPLETION_ID, RECOVERY_ID, RECOVERY_JOBS, MonitorError, createApi, createCollector, createPoller, portalBase, summarize } from '../progress.js';
const ids = ['clef-local', 'gemma-local'];
const now = '2026-11-13T03:00:00.000Z';
const counts = (profileId, total, completed = 0, partial = 0, running = 0, failed = 0) => ({ profileId, total, completed, partial, failed, running, pending: total - completed - partial - running - failed });
function job(id, total, progress, key) {
  return { id, purpose: 'operational', status: 'running', conversationIds: Array.from({ length: total }, (_, i) => `${id}-${i}`),
    modelProfiles: ids.map(id => ({ id })), modelProgress: progress, idempotencyKey: key,
    createdAt: now, updatedAt: now };
}
function fixture({ retriesDone = false, phase, finished = false } = {}) {
  const jobs = [job(RECOVERY_JOBS[0], 52, ids.map(id => counts(id, 52, 52))),
    job(RECOVERY_JOBS[1], 312, [counts(ids[0], 312, 311, 1), counts(ids[1], 312, retriesDone ? 312 : 310, retriesDone ? 0 : 2)])];
  jobs[0].status = 'completed'; jobs[1].status = 'partial';
  for (const [key, total] of [['tuesday', 167], ['wednesday', 43]]) if (phase === key || finished) {
    jobs.push(job(`new-${key}`, total, ids.map(id => counts(id, total, finished ? total : 0)), `${COMPLETION_ID}:${key}`));
    if (finished) jobs.at(-1).status = 'completed';
  }
  return { jobs, settings: { evaluationMaintenance: finished ? null : RECOVERY_ID,
    tuesdayWednesdayCompletion: { id: COMPLETION_ID, status: finished ? 'completed' : 'running', concurrency: 1 } } };
}
test('scope remains 212 conversations and 422 reviews, excludes old Clef and all 725 preserved reviews', () => {
  const data = summarize(fixture(), now);
  assert.deepEqual([data.target, data.requested, data.excluded, data.preserved, data.total], [212, 213, 1, 725, 422]);
  assert.deepEqual([data.completed, data.partial, data.failed, data.running, data.pending], [0, 2, 0, 0, 420]);
  assert.deepEqual(data.models.map(model => [model.total, model.completed, model.partial, model.pending]), [[210, 0, 0, 210], [212, 0, 2, 210]]);
  assert.equal(data.percent, 0); assert.equal(data.finished, false); assert.equal(data.paused, false);
  assert.equal(data.completedConversations, undefined);
  assert.deepEqual(data.phases.map(phase => [phase.target, phase.totalReviews, phase.unassigned, phase.counts.pending]), [[169, 336, 167, 334], [43, 86, 43, 86]]);
});
test('counts two Gemma retries once, and includes Wednesday pending before that batch exists', () => {
  const payload = fixture({ retriesDone: true, phase: 'tuesday' }), tuesday = payload.jobs.at(-1);
  tuesday.modelProgress = [counts(ids[0], 167, 5, 0, 1), counts(ids[1], 167, 4, 1)];
  const data = summarize(payload, now);
  assert.deepEqual([data.completed, data.partial, data.running, data.pending], [11, 1, 1, 409]);
  assert.deepEqual(data.models.map(model => [model.completed, model.total]), [[5, 210], [6, 212]]);
  assert.equal(data.percent, 11 / 422 * 100); assert.equal(data.paused, false); assert.equal(data.models[0].active, true);
  assert.equal(data.phases[0].counts.completed, 11); assert.equal(data.phases[1].counts.pending, 86);
  assert.equal(data.phases[1].unassigned, 43); assert.equal(data.completedConversations, undefined);
});
test('only fully completed 422 reviews plus committed completion finish the monitor', () => {
  const payload = fixture({ retriesDone: true, finished: true });
  let data = summarize(payload, now); assert.equal(data.finished, true); assert.equal(data.percent, 100); assert.equal(data.partial, 0);
  assert.deepEqual(data.phases.map(phase => phase.counts.completed), [336, 86]);
  assert.equal(data.models[0].completed, 210); assert.equal(data.models[1].completed, 212);
  payload.settings.tuesdayWednesdayCompletion.status = 'running'; data = summarize(payload, now); assert.equal(data.finished, false);
  payload.jobs.at(-1).modelProgress[1] = counts(ids[1], 43, 42, 1);
  payload.settings.tuesdayWednesdayCompletion.status = 'completed'; data = summarize(payload, now);
  assert.equal(data.finished, false); assert.equal(data.completed, 421); assert.equal(data.partial, 1); assert.ok(data.percent < 100);
});
test('ignores unrelated runs and rejects duplicate membership, corrupted totals and missing baselines', () => {
  const payload = fixture(); payload.jobs.push({ id: 'irrelevant', dailyActivity: { date: '2026-11-10' }, idempotencyKey: 'another-run:tuesday' });
  assert.equal(summarize(payload, now).total, 422);
  for (const mutate of [p => p.jobs.pop(), p => p.jobs.push(p.jobs[0]), p => { p.jobs[1].modelProgress[1].completed--; },
    p => { p.jobs[1].modelProgress[1] = counts(ids[1], 312, 309, 3); },
    p => { p.jobs[1].conversationIds[0] = p.jobs[0].conversationIds[0]; }]) {
    const invalid = fixture(); mutate(invalid); assert.throws(() => summarize(invalid, now), MonitorError);
  }
  const duplicate = fixture({ phase: 'tuesday' }); duplicate.jobs.push({ ...duplicate.jobs.at(-1), id: 'duplicate-key' });
  assert.throws(() => summarize(duplicate, now), MonitorError);
});
test('own maintenance is not a pause; heartbeat identifies stale running work and explicit blocks', () => {
  const payload = fixture({ retriesDone: true, phase: 'tuesday' }), tuesday = payload.jobs.at(-1);
  tuesday.modelProgress[0] = counts(ids[0], 167, 0, 0, 1);
  let data = summarize(payload, now); assert.equal(data.paused, false); assert.equal(data.stalled, false); assert.equal(data.models[0].active, true);
  tuesday.updatedAt = '2026-11-13T02:40:00.000Z'; data = summarize(payload, now);
  assert.equal(data.stalled, true); assert.equal(data.models[0].active, false); assert.equal(data.paused, false);
  payload.settings.tuesdayWednesdayCompletion.status = 'blocked'; tuesday.status = 'partial';
  data = summarize(payload, now); assert.equal(data.blocked, true); assert.equal(data.paused, false);
  assert.equal(summarize(fixture({ retriesDone: true }), now).interrupted, false);
});
test('collector uses one authenticated read and returns no conversation membership or answer data', async () => {
  const calls = [], collect = createCollector(async route => { calls.push(route); return fixture(); });
  const data = await collect(); assert.deepEqual(calls, ['/evaluations']);
  assert.ok(data.batches.every(batch => !('conversationIds' in batch) && !('modelProfiles' in batch)));
});
test('prepared workers use their start time and cannot look healthy indefinitely between phases', () => {
  const payload = fixture({ retriesDone: true });
  payload.jobs.forEach(job => { job.updatedAt = '2026-11-13T01:00:00.000Z'; });
  Object.assign(payload.settings.tuesdayWednesdayCompletion, { status: 'prepared', preparedAt: now });
  let data = summarize(payload, '2026-11-13T03:01:00.000Z');
  assert.equal(data.preparing, true); assert.equal(data.stalled, false); assert.equal(data.activity, now);
  data = summarize(payload, '2026-11-13T03:20:00.000Z');
  assert.equal(data.preparing, false); assert.equal(data.stalled, true); assert.equal(data.paused, false);
});
test('cliente conserva la sesión del portal y distingue acceso vencido de error de servidor', async () => {
  assert.equal(portalBase('/pulsoAtom/monitor-evaluaciones/index.html'),'/pulsoAtom');
  assert.throws(()=>portalBase('/monitor-evaluaciones/index.html'));
  let request;const api=createApi('/pulsoAtom',async(...args)=>{request=args;return{status:401,ok:false};});
  await assert.rejects(api('/evaluations'),error=>error.status===401);
  assert.equal(request[0],'/pulsoAtom/api/evaluations');assert.equal(request[1].credentials,'same-origin');assert.equal(request[1].method,undefined);
});
test('la actualización nunca se superpone y sigue entre lotes terminados y se detiene al perder sesión', async () => {
  let resolve,calls=0,scheduled=0;
  const poller=createPoller({collect:()=>{calls++;return new Promise(r=>{resolve=r;});},schedule:()=>{scheduled++;return 1;},cancel(){}});
  const first=poller.refresh();await poller.refresh();assert.equal(calls,1);resolve({finished:false});await first;assert.equal(scheduled,1);
  const second=poller.refresh();resolve({finished:true});await second;assert.equal(scheduled,2);poller.stop();
  const auth=createPoller({collect:async()=>{throw new MonitorError('Sesión',401);},schedule:()=>{scheduled++;return 1;},cancel(){}});
  await auth.refresh();assert.equal(scheduled,2);auth.stop();
});

test('waiting_thursday conserva el pendiente de martes sin anunciar una interrupción de la fase activa', () => {
  const payload = fixture({ retriesDone: true, phase: 'tuesday' });
  payload.settings.evaluationMaintenance = null;
  Object.assign(payload.settings.tuesdayWednesdayCompletion, { status: 'waiting_thursday', priority: {
    order: 'wednesday-thursday-tuesday', resumeTuesday: 'automatic_before_noon', deadline: '2026-11-13T18:00:00.000Z',
  } });
  payload.jobs.find(job => job.id === 'new-tuesday').status = 'interrupted';
  const data = summarize(payload, now);
  assert.equal(data.waitingThursday, true);
  assert.equal(data.runStatus, 'waiting_thursday');
  assert.equal(data.interrupted, false);
  assert.equal(data.stalled, false);
  assert.equal(data.paused, false);
  assert.equal(data.tuesdayDeadline, '2026-11-13T18:00:00.000Z');
  assert.ok(data.pending > 0);
});
