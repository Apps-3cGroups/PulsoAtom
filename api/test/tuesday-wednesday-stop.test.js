import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPLETION_ID } from '../src/tuesday-wednesday-completion.js';
import { processState, stopOwnedWorker } from '../scripts/complete-tuesday-wednesday.js';

const manifest = () => ({ id: COMPLETION_ID, pid: 12345, status: 'running', plan: { frozen: true } });
test('stop refuses a different process identity without sending a signal', async () => {
  const signals = [], value = manifest();
  await assert.rejects(stopOwnedWorker(value, {
    inspect: (pid, script) => processState(pid, script, { kill() {}, read: async path => path.endsWith('stat') ? `${pid} (node) S text` : 'node\0/unrelated.js\0--worker\0' }),
    signal: (...args) => signals.push(args),
  }), error => error.code === 'WORKER_IDENTITY_CHANGED');
  assert.deepEqual(signals, []); assert.equal(value.status, 'running');
});
test('an already dead worker receives no signal and retains its manifest PID', async () => {
  const signals = [], value = manifest(), before = structuredClone(value);
  assert.deepEqual(await stopOwnedWorker(value, { inspect: async () => ({ alive: false }), signal: (...args) => signals.push(args) }),
    { stopped: false, alreadyStopped: true, workerAlive: false });
  assert.deepEqual(signals, []); assert.deepEqual(value, before);
});
test('a verified worker receives exactly one SIGTERM and must be proved dead', async () => {
  const signals = [], inspections = [], value = manifest(), before = structuredClone(value); let alive = true;
  const result = await stopOwnedWorker(value, {
    inspect: async (pid, script) => { inspections.push({ pid, script }); return { alive }; },
    signal: (pid, signal) => { signals.push([pid, signal]); alive = false; }, pause: async () => {},
  });
  assert.deepEqual(signals, [[12345, 'SIGTERM']]); assert.equal(inspections.length, 2);
  assert.ok(inspections.every(row => row.pid === 12345 && row.script.endsWith('/worker-api/scripts/complete-tuesday-wednesday.js')));
  assert.deepEqual(result, { stopped: true, workerAlive: false }); assert.deepEqual(value, before);
});
test('timeout leaves live worker untouched after SIGTERM with no SIGKILL or manifest mutation', async () => {
  const value = manifest(), before = structuredClone(value), signals = []; let waits = 0;
  await assert.rejects(stopOwnedWorker(value, { inspect: async () => ({ alive: true }),
    signal: (...args) => signals.push(args), pause: async () => { waits++; }, maxWaitMs: 300 }), error => error.code === 'WORKER_STOP_TIMEOUT');
  assert.deepEqual(signals, [[12345, 'SIGTERM']]); assert.equal(waits, 3); assert.deepEqual(value, before);
});
test('temporary empty or changed identity after SIGTERM waits for positive death proof', async () => {
  let checks = 0, waits = 0; const signals = [];
  const result = await stopOwnedWorker(manifest(), { inspect: async () => {
    checks++;
    if (checks === 2) throw Object.assign(new Error(), { code: 'WORKER_IDENTITY_CHANGED' });
    return { alive: checks === 1 };
  }, signal: (...args) => signals.push(args), pause: async () => { waits++; } });
  assert.deepEqual(signals, [[12345, 'SIGTERM']]); assert.equal(checks, 3); assert.equal(waits, 1);
  assert.deepEqual(result, { stopped: true, workerAlive: false });
});
test('a replacement or uncertain live PID times out without signaling the replacement or declaring death', async () => {
  let checks = 0; const signals = [];
  await assert.rejects(stopOwnedWorker(manifest(), { inspect: async () => {
    if (++checks > 1) throw Object.assign(new Error(), { code: 'WORKER_IDENTITY_CHANGED' }); return { alive: true };
  }, signal: (...args) => signals.push(args), pause: async () => {}, maxWaitMs: 300 }), error => error.code === 'WORKER_STOP_TIMEOUT');
  assert.deepEqual(signals, [[12345, 'SIGTERM']]);
});
