import test from 'node:test';
import assert from 'node:assert/strict';
import { COHORT_ID, MonitorError, createApi, createCollector, createPoller, portalBase, sanitizeTasks, summarize } from '../progress.js';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const makeJob = (index = 0, count = 20) => ({ id: id(index + 1), cohortId: COHORT_ID, cohortBatchIndex: index, status: 'running', updatedAt: '2026-11-07T22:00:00Z', conversationIds: Array.from({ length: count }, (_, i) => String(index * 20 + i)) });
const makeTasks = (job, status = 'completed', profile = 'clef-local') => job.conversationIds.map(conversationId => ({ id: `${profile}-${conversationId}`, jobId: job.id, conversationId, status, profile: { id: profile } }));

test('portal path stays namespaced and rejects routes outside the monitor', () => {
  assert.equal(portalBase('/pulsoAtom/monitor-clef/index.html'), '/pulsoAtom');
  assert.equal(portalBase('/pulsoAtom/monitor-clef/'), '/pulsoAtom');
  assert.throws(() => portalBase('/monitor-clef/index.html'));
  assert.throws(() => portalBase('/pulsoAtom/other/index.html'));
});

test('Clef counts exclude Gemma, repeated same task, attempts, and blocks not yet created', () => {
  const job = makeJob();
  const tasks = makeTasks(job);
  tasks[0].status = 'partial'; tasks[1].status = 'failed'; tasks[2].status = 'running';
  const cleaned = sanitizeTasks(job, { tasks: [...tasks, tasks[0], ...makeTasks(job, 'completed', 'gemma-local')], attempts: [{ status: 'completed' }] });
  const result = summarize([job, { ...makeJob(1), cohortId: 'another-cohort' }], new Map([[job.id, cleaned]]));
  assert.deepEqual([result.completed, result.partial, result.failed, result.running, result.pending], [17, 1, 1, 1, 480]);
  assert.equal(result.processed, 19); assert.equal(result.finished, false);
  assert.deepEqual(Object.keys(cleaned[0]), ['id', 'conversationId', 'status']);
});

test('unknown, missing, conflicting and duplicate-conversation tasks fail closed', () => {
  const job = makeJob(0, 1), tasks = makeTasks(job);
  assert.throws(() => sanitizeTasks(job, { tasks: [] }));
  assert.throws(() => sanitizeTasks(job, { tasks: [{ ...tasks[0], status: 'unexpected' }] }));
  assert.throws(() => sanitizeTasks(job, { tasks: [...tasks, { ...tasks[0], id: 'duplicate', status: 'partial' }] }));
  const second = { ...makeJob(1, 1), conversationIds: job.conversationIds };
  assert.throws(() => summarize([job, second], new Map([[job.id, tasks], [second.id, makeTasks(second)]])));
});

test('interrupted tasks remain pending, not failed or no-flag', () => {
  const job = { ...makeJob(0, 1), status: 'interrupted' };
  const result = summarize([job], new Map([[job.id, makeTasks(job, 'interrupted')]]));
  assert.equal(result.pending, 500); assert.equal(result.failed, 0); assert.equal(result.interrupted, true);
});

test('terminal completion requires all 500 Clef tasks and terminal jobs', () => {
  const jobs = Array.from({ length: 25 }, (_, i) => ({ ...makeJob(i), status: 'completed' }));
  const tasks = new Map(jobs.map(job => [job.id, makeTasks(job)]));
  tasks.get(jobs[0].id)[0].status = 'partial';
  const complete = summarize(jobs, tasks);
  assert.equal(complete.finished, true); assert.equal(complete.completed, 499); assert.equal(complete.partial, 1);
  jobs[24].status = 'running';
  assert.equal(summarize(jobs, tasks).finished, false);
});

test('collector caches unchanged jobs and refreshes partial tasks after resume', async () => {
  const job = { ...makeJob(0, 1), status: 'partial' };
  let details = 0, status = 'partial';
  const collect = createCollector(async path => {
    if (path === '/auth/me') return { user: { role: 'admin' } };
    if (path === '/evaluations') return { jobs: [{ ...job }] };
    details++; return { tasks: makeTasks(job, status) };
  });
  assert.equal((await collect()).partial, 1);
  await collect(); assert.equal(details, 1);
  job.updatedAt = '2026-11-07T22:02:00Z'; job.status = 'completed'; status = 'completed';
  assert.equal((await collect()).completed, 1); assert.equal(details, 2);
});

test('collector limits task requests to two and never commits an incomplete snapshot', async () => {
  const jobs = [makeJob(0, 1), makeJob(1, 1), makeJob(2, 1)];
  let active = 0, max = 0, details = 0, fail = true;
  const collect = createCollector(async path => {
    if (path === '/auth/me') return { user: { role: 'admin' } };
    if (path === '/evaluations') return { jobs };
    active++; max = Math.max(max, active); details++;
    await new Promise(resolve => setImmediate(resolve)); active--;
    const job = jobs.find(job => path.includes(job.id));
    if (fail && job.id === jobs[2].id) throw new MonitorError('Failed');
    return { tasks: makeTasks(job) };
  });
  await assert.rejects(collect()); fail = false;
  const result = await collect();
  assert.equal(result.completed, 3); assert.equal(max, 2); assert.equal(details, 6);
});

test('collector rejects supervisor before reading jobs', async () => {
  const calls = [];
  const collect = createCollector(async path => { calls.push(path); return { user: { role: 'supervisor' } }; });
  await assert.rejects(collect(), error => error.status === 403);
  assert.deepEqual(calls, ['/auth/me']);
});

test('client sends no credentials outside same-origin API and masks server details', async () => {
  let request;
  const api = createApi('/pulsoAtom', async (...args) => { request = args; return { status: 401, ok: false }; });
  await assert.rejects(api('/evaluations'), error => error.status === 401);
  assert.equal(request[0], '/pulsoAtom/api/evaluations');
  assert.equal(request[1].credentials, 'same-origin'); assert.equal(request[1].method, undefined);
  const invalid = createApi('/pulsoAtom', async () => ({ status: 500, ok: false }));
  await assert.rejects(invalid('/evaluations'), /servidor no respondió/);
});

test('poller avoids overlap, stops on auth failure, and can restart manually', async () => {
  let resolve, scheduled = 0, cancelled = 0, called = 0, error, good = false;
  const poller = createPoller({ collect: () => { called++; return new Promise(r => { resolve = r; }); },
    onData: () => { good = true; }, onError: value => { error = value; },
    schedule: () => { scheduled++; return 1; }, cancel: () => { cancelled++; } });
  const first = poller.refresh(); await poller.refresh(); assert.equal(called, 1);
  resolve({ finished: false }); await first; assert.equal(scheduled, 1); assert.equal(good, true);
  const second = poller.refresh(); resolve({ finished: true }); await second;
  assert.equal(scheduled, 1); assert.equal(cancelled, 1); assert.equal(error, undefined); poller.stop();
  let pass = false;
  const auth = createPoller({ collect: async () => { if (!pass) throw new MonitorError('Auth', 401); return { finished: false }; },
    onData() {}, onError: value => { error = value; }, schedule: () => { scheduled++; return 1; }, cancel() {} });
  await auth.refresh(); assert.equal(error.status, 401); assert.equal(scheduled, 1);
  pass = true; await auth.refresh(); assert.equal(scheduled, 2); auth.stop();
});
