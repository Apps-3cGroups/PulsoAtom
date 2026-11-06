import test from 'node:test';
import assert from 'node:assert/strict';
import { startEvaluationHeartbeat } from '../src/evaluation-heartbeat.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
function manualTimer() {
  let tick;
  const timer = { unrefCalls: 0, cancelCalls: 0, unref() { this.unrefCalls++; } };
  return {
    timer,
    tick() { tick(); },
    options: {
      setInterval(callback, interval) { assert.equal(interval, 30_000); tick = callback; return timer; },
      clearInterval(handle) { assert.equal(handle, timer); timer.cancelCalls++; },
    },
  };
}

test('slow heartbeat skips overlapping ticks instead of queuing writes', async () => {
  const clock = manualTimer(), first = deferred(), second = deferred();
  let writes = 0;
  const stop = startEvaluationHeartbeat(() => (++writes === 1 ? first : second).promise, clock.options);
  assert.equal(clock.timer.unrefCalls, 1);
  clock.tick();
  clock.tick();
  await flush();
  assert.equal(writes, 1);
  for (let i = 0; i < 10; i++) clock.tick();
  await flush();
  assert.equal(writes, 1);
  first.resolve();
  await flush();
  assert.equal(writes, 1, 'skipped ticks must not become a backlog');
  clock.tick();
  await flush();
  assert.equal(writes, 2, 'the next scheduled tick may write after completion');
  second.resolve();
  await stop();
});

test('stopping cancels future ticks and waits for the pending heartbeat before completing', async () => {
  const clock = manualTimer(), write = deferred();
  let writes = 0, stopped = false;
  const stop = startEvaluationHeartbeat(() => { writes++; return write.promise; }, clock.options);
  clock.tick();
  await flush();
  const completion = stop().then(() => { stopped = true; });
  assert.equal(clock.timer.cancelCalls, 1);
  // Even a callback already queued when clearInterval runs must be harmless.
  clock.tick();
  await flush();
  assert.equal(writes, 1);
  assert.equal(stopped, false);
  write.resolve();
  await completion;
  assert.equal(stopped, true);
  clock.tick();
  await flush();
  assert.equal(writes, 1);
});

test('heartbeat errors do not reject shutdown or prevent subsequent ticks', async () => {
  const clock = manualTimer(), failedWrite = deferred(), finalWrite = deferred();
  let writes = 0;
  const stop = startEvaluationHeartbeat(() => {
    writes++;
    if (writes === 1) return failedWrite.promise;
    if (writes === 2) throw new Error('synchronous store failure');
    return finalWrite.promise;
  }, clock.options);
  clock.tick();
  await flush();
  failedWrite.reject(new Error('slow store failure'));
  await flush();
  clock.tick();
  await flush();
  assert.equal(writes, 2);
  clock.tick();
  await flush();
  assert.equal(writes, 3);
  const completion = stop();
  finalWrite.reject(new Error('store failure during shutdown'));
  await assert.doesNotReject(completion);
});
