import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSchedule, verifySchedule } from '../src/services/schedule.js';
import { api } from '../src/services/api.js';

const original = { dailyEnabled: false, dailyTime: '07:00', timezone: 'America/Tegucigalpa', version: 1 };
const desired = { dailyEnabled: true, dailyTime: '07:00', timezone: 'America/Tegucigalpa' };
const committed = { ...desired, version: 2, dailyStartedAt: '2026-10-29T19:41:24.127Z' };

test('guardar confirma los valores devueltos por el servidor con control de versión', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return Response.json({ settings: committed }); });
  const result = await saveSchedule(desired, 1);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.verified, false);
  assert.deepEqual(result.settings, committed);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/pulsoAtom/api/evaluations/settings');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0].options.body), { ...desired, expectedVersion: 1 });
});

for (const interruption of ['lost-response', 'truncated-json', 'gateway-timeout']) {
  test(`un guardado confirmado en lectura después de ${interruption} no repite la escritura`, async t => {
    const methods = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      methods.push(options.method);
      if (options.method === 'GET') return Response.json({ settings: committed });
      if (interruption === 'truncated-json') return new Response('{"settings":', { headers: { 'Content-Type': 'application/json' } });
      if (interruption === 'gateway-timeout') return new Response('Gateway timeout', { status: 504 });
      throw new TypeError('Network connection lost after commit');
    });
    const result = await saveSchedule(desired, 1);
    assert.equal(result.status, 'confirmed');
    assert.equal(result.verified, true);
    assert.deepEqual(result.settings, committed);
    assert.deepEqual(methods, ['PATCH', 'GET']);
  });
}

test('una escritura no confirmada conserva el estado anterior y no anuncia éxito', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'PATCH') throw new TypeError('Offline');
    return Response.json({ settings: original });
  });
  const result = await saveSchedule(desired, 1);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.settings.dailyEnabled, false);
});

test('sin conexión no se presume éxito ni fracaso; al recuperarla solo se consulta', async t => {
  let online = false;
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    methods.push(options.method);
    if (!online) throw new TypeError('Offline');
    return Response.json({ settings: committed });
  });
  assert.deepEqual(await saveSchedule(desired, 1), { status: 'unknown' });
  online = true;
  assert.equal((await verifySchedule(desired, 1)).status, 'confirmed');
  assert.deepEqual(methods, ['PATCH', 'GET', 'GET']);
});

test('un conflicto de versión recupera el horario vigente sin sobrescribirlo', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => options.method === 'PATCH'
    ? Response.json({ error: { code: 'VERSION_CONFLICT', message: 'Cambió el horario' } }, { status: 409 })
    : Response.json({ settings: { ...committed, dailyTime: '08:30' } }));
  const result = await saveSchedule(desired, 1);
  assert.equal(result.status, 'conflict');
  assert.equal(result.settings.dailyTime, '08:30');
});

test('autorización y validación fallidas no se ocultan con una lectura posterior', async t => {
  for (const status of [403, 409, 422]) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: { code: 'REJECTED', message: 'No autorizado o no válido' } }, { status }); });
    await assert.rejects(saveSchedule(desired, 1), error => error.status === status && error.code === 'REJECTED');
    assert.equal(calls, 1);
    mock.mock.restore();
  }
});

test('una respuesta vacía o incompatible no se anuncia como guardado', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ settings: { dailyEnabled: true } }));
  assert.deepEqual(await saveSchedule(desired, 1), { status: 'unknown' });
});

test('el timeout del cliente termina la espera sin atribuir el fallo a la API apagada', async t => {
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  await assert.rejects(api('/evaluations/settings', { timeoutMs: 5 }), error => error.code === 'TIMEOUT');
});

test('la cancelación de una consulta al desmontar conserva AbortError', async t => {
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const controller = new AbortController();
  const pending = api('/evaluations/settings', { signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
