import test from 'node:test';
import assert from 'node:assert/strict';
import { startApiQuery } from '../src/services/apiQuery.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function observe() {
  const state = { data: null, error: null, loading: false, received: [] };
  return { state, callbacks: {
    onLoading: value => { state.loading = value; },
    onError: value => { state.error = value; },
    onData: value => { state.data = value; state.received.push(value); },
  } };
}
const polling = { timeoutMs: 30000, pollIntervalMs: 3000, pollWhile: data => data.status === 'running' };

test('una consulta mayor de 3 segundos termina antes de consultar otra vez y nunca ejecuta modelos', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise(resolve => { calls.push({ url, options, resolve }); }));
  const { state, callbacks } = observe();
  const stop = startApiQuery('/comparisons/sample-a?reveal=true', { ...callbacks, ...polling });
  t.after(stop);
  t.mock.timers.tick(6500);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, false);
  assert.equal(state.loading, true);
  calls[0].resolve(Response.json({ id: 'sample-a', revealed: true, status: 'running', completed: 0 }));
  await flush();
  assert.equal(state.data.revealed, true);
  assert.equal(state.loading, false);
  t.mock.timers.tick(2999);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  assert.equal(calls.length, 2);
  t.mock.timers.tick(4000);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.signal.aborted, false);
  calls[1].resolve(Response.json({ id: 'sample-a', revealed: true, status: 'completed', completed: 2 }));
  await flush();
  t.mock.timers.tick(60000);
  assert.equal(calls.length, 2);
  assert.deepEqual(state.received.map(value => value.completed), [0, 2]);
  assert.equal(state.error, null);
  assert.ok(calls.every(({ url, options }) => url === '/pulsoAtom/api/comparisons/sample-a?reveal=true' && options.method === 'GET' && !options.body));
});

test('cambiar muestra o reveal cancela el ciclo previo y descarta respuestas tardías', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  // Simulate a transport that still resolves after cancellation.
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise(resolve => { calls.push({ url, options, resolve }); }));
  const { state, callbacks } = observe();
  const hidden = startApiQuery('/comparisons/a?reveal=false', { ...callbacks, ...polling });
  calls[0].resolve(Response.json({ id: 'a', revealed: false, status: 'running' }));
  await flush();
  hidden();
  const revealed = startApiQuery('/comparisons/a?reveal=true', { ...callbacks, ...polling });
  t.mock.timers.tick(3001);
  assert.equal(calls.length, 2, 'el temporizador anterior no inicia una consulta oculta');
  revealed();
  assert.equal(calls[1].options.signal.aborted, true);
  const next = startApiQuery('/comparisons/b?reveal=false', { ...callbacks, ...polling });
  t.after(next);
  calls[2].resolve(Response.json({ id: 'b', revealed: false, status: 'completed' }));
  await flush();
  calls[1].resolve(Response.json({ id: 'a', revealed: true, status: 'running' }));
  await flush();
  t.mock.timers.tick(60000);
  assert.equal(calls.length, 3);
  assert.equal(state.data.id, 'b');
  assert.deepEqual(state.received.map(value => `${value.id}:${value.revealed}`), ['a:false', 'b:false']);
  assert.equal(state.loading, false);
});

test('timeout conserva el último dato, detiene polling y reintentar solo consulta el avance', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise((resolve, reject) => {
    calls.push({ url, options, resolve });
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const { state, callbacks } = observe();
  const stop = startApiQuery('/evaluations/job-a/attempts', { ...callbacks, ...polling, pollWhile: () => true });
  calls[0].resolve(Response.json({ attempts: [{ status: 'running' }] }));
  await flush();
  t.mock.timers.tick(3000);
  assert.equal(calls.length, 2);
  t.mock.timers.tick(30000);
  await flush();
  assert.equal(state.error.code, 'TIMEOUT');
  assert.equal(state.loading, false);
  assert.equal(state.data.attempts[0].status, 'running');
  t.mock.timers.tick(120000);
  assert.equal(calls.length, 2, 'un timeout no genera reintentos automáticos');
  stop();
  const retry = startApiQuery('/evaluations/job-a/attempts', { ...callbacks, timeoutMs: 30000 });
  t.after(retry);
  calls[2].resolve(Response.json({ attempts: [{ status: 'completed' }] }));
  await flush();
  assert.equal(state.error, null);
  assert.equal(state.data.attempts[0].status, 'completed');
  assert.ok(calls.every(({ url, options }) => url.endsWith('/evaluations/job-a/attempts') && options.method === 'GET' && !options.body));
});

test('la lectura simple sigue siendo única y desmontar no publica errores ni datos tardíos', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise(resolve => { calls.push({ url, options, resolve }); }));
  const first = observe();
  const stop = startApiQuery('/comparisons', first.callbacks);
  calls[0].resolve(Response.json({ status: 'running' }));
  await flush();
  t.mock.timers.tick(60000);
  assert.equal(calls.length, 1);
  stop();
  const second = observe();
  const cancel = startApiQuery('/comparisons/a?reveal=true', { ...second.callbacks, ...polling });
  cancel();
  assert.equal(calls[1].options.signal.aborted, true);
  calls[1].resolve(Response.json({ status: 'running' }));
  await flush();
  t.mock.timers.tick(60000);
  assert.equal(second.state.data, null);
  assert.equal(second.state.error, null);
  assert.equal(calls.length, 2);
});
