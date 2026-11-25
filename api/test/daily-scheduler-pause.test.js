import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { startDailyScheduler } from '../src/daily-scheduler.js';

function schedulerClock(t) {
  let callback;
  const timer = { unref: t.mock.fn() };
  t.mock.method(globalThis, 'setInterval', (fn, milliseconds) => {
    assert.equal(milliseconds, 5000);
    callback = fn;
    return timer;
  });
  const clear = t.mock.method(globalThis, 'clearInterval', value => assert.equal(value, timer));
  return { tick: () => callback(), timer, clear };
}

function fixture() {
  const calls = { settings: 0, scheduler: 0, read: 0, source: 0, automation: 0, transaction: 0, inference: 0 };
  const state = {
    settings: { evaluationMaintenance: 'user-pause', dailyEnabled: false },
    jobs: [{ id: 'stale-job', status: 'running', updatedAt: '2000-01-01T00:00:00.000Z' }],
    tasks: [{ id: 'stale-task', jobId: 'stale-job', status: 'running' }],
    attempts: [{ id: 'stale-attempt', jobId: 'stale-job', status: 'running' }],
  };
  const store = {
    async readSettings() { calls.settings++; return structuredClone(state.settings); },
    async readSchedulerState() { calls.scheduler++; return structuredClone(state); },
    async read() { calls.read++; throw new Error('Unexpected full read'); },
    async readWithConversations() { calls.source++; throw new Error('Unexpected source read'); },
    async readAutomationState() { calls.automation++; throw new Error('Unexpected automation read'); },
    async transaction(fn) { calls.transaction++; return fn(state); },
  };
  const evaluator = { async evaluate() { calls.inference++; throw new Error('Unexpected inference'); } };
  return { calls, state, store, evaluator };
}

test('paused scheduler only reads settings, without queue reads, recovery or inference', async t => {
  const clock = schedulerClock(t);
  const { calls, state, store, evaluator } = fixture();
  const original = structuredClone(state);
  const stop = startDailyScheduler(store, evaluator);
  t.after(stop);
  await setImmediate();
  await clock.tick();
  await clock.tick();
  assert.deepEqual(calls, { settings: 3, scheduler: 0, read: 0, source: 0, automation: 0, transaction: 0, inference: 0 });
  assert.deepEqual(state, original);
  assert.equal(clock.timer.unref.mock.callCount(), 1);
});

test('clearing the pause resumes the normal scheduler and recovery on the next tick', async t => {
  const clock = schedulerClock(t);
  const { calls, state, store, evaluator } = fixture();
  const stop = startDailyScheduler(store, evaluator);
  t.after(stop);
  await setImmediate();
  assert.equal(state.jobs[0].status, 'running');
  delete state.settings.evaluationMaintenance;
  await clock.tick();
  assert.equal(calls.settings, 2);
  assert.equal(calls.scheduler, 3);
  assert.equal(calls.transaction, 1);
  assert.equal(state.jobs[0].status, 'interrupted');
  assert.equal(state.tasks[0].status, 'interrupted');
  assert.equal(state.attempts[0].status, 'interrupted');
  assert.equal(calls.inference, 0);
  assert.equal(calls.read + calls.source + calls.automation, 0);
});

test('settings failures fail closed and leave subsequent pause checks available', async t => {
  const clock = schedulerClock(t);
  const { calls, store, evaluator } = fixture();
  const errors = t.mock.method(console, 'error', () => {});
  store.readSettings = async () => { calls.settings++; throw Object.assign(new Error('Unavailable'), { code: 'ECONNREFUSED' }); };
  const stop = startDailyScheduler(store, evaluator);
  t.after(stop);
  await setImmediate();
  await clock.tick();
  assert.deepEqual(calls, { settings: 2, scheduler: 0, read: 0, source: 0, automation: 0, transaction: 0, inference: 0 });
  assert.equal(errors.mock.callCount(), 2);
  assert.deepEqual(errors.mock.calls[0].arguments, ['Error al iniciar evaluación diaria de Pulso:', 'ECONNREFUSED']);
});
