import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createWebServer } from '../server.js';

test('el servidor respeta /pulsoAtom, recarga rutas internas y conserva el prefijo de la API', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pulso-web-test-'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="es"><body>Pulso</body></html>');
  await writeFile(path.join(directory, 'asset.js'), 'const pulso = true;');
  const api = express();
  api.use(express.json());
  api.get('/pulsoAtom/api/probe', (_req, res) => res.json({ reached: true }));
  api.patch('/pulsoAtom/api/evaluations/settings', (req, res) => res.json({ method: req.method, body: req.body }));
  const backend = api.listen(0, '127.0.0.1');
  await new Promise(resolve => backend.once('listening', resolve));
  const server = createWebServer({ basePath: '/pulsoAtom', dist: directory, apiTarget: `http://127.0.0.1:${backend.address().port}` }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ['/pulsoAtom', '/pulsoAtom/catalogo', '/pulsoAtom/conversacion/DEMO-MX-0001', '/pulsoAtom/evaluaciones', '/pulsoAtom/comparacion', '/pulsoAtom/comparacion/sample/validar/case']) {
      const response = await fetch(`${origin}${route}`, { headers: { Accept: 'text/html' } });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<body>Pulso/);
    }
    assert.equal((await fetch(`${origin}/`)).status, 404);
    assert.equal((await fetch(`${origin}/api/probe`)).status, 404);
    assert.equal((await fetch(`${origin}/pulsoAtom/missing.js`)).status, 404);
    assert.match(await (await fetch(`${origin}/pulsoAtom/asset.js`)).text(), /pulso = true/);
    assert.deepEqual(await (await fetch(`${origin}/pulsoAtom/api/probe`)).json(), { reached: true });
    const settings = { dailyEnabled: true, dailyTime: '07:00', timezone: 'America/Tegucigalpa', expectedVersion: 1 };
    const saved = await fetch(`${origin}/pulsoAtom/api/evaluations/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    assert.deepEqual(await saved.json(), { method: 'PATCH', body: settings });
  } finally {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => backend.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('una subruta alternativa conserva recargas, recursos y el prefijo exacto del proxy', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pulso-custom-path-'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><body>Custom Pulso</body>');
  await writeFile(path.join(directory, 'asset.js'), 'const custom = true;');
  const api = express();
  api.get('/operacion/pulsoAtom/api/probe', (req, res) => res.json({ path: req.path, value: req.query.value }));
  api.use((_req, res) => res.status(404).json({ error: 'API_NOT_FOUND' }));
  const backend = api.listen(0, '127.0.0.1');
  await new Promise(resolve => backend.once('listening', resolve));
  const server = createWebServer({ basePath: '/operacion/pulsoAtom/', dist: directory, apiTarget: `http://127.0.0.1:${backend.address().port}` }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ['/operacion/pulsoAtom', '/operacion/pulsoAtom/catalogo', '/operacion/pulsoAtom/conversacion/42']) {
      const response = await fetch(`${origin}${route}`, { headers: { Accept: 'text/html' } });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Custom Pulso/);
    }
    assert.equal((await fetch(`${origin}/`)).status, 404);
    assert.equal((await fetch(`${origin}/pulsoAtom/catalogo`)).status, 404);
    assert.equal((await fetch(`${origin}/operacion/pulsoAtom-extra/api/probe`)).status, 404);
    assert.match(await (await fetch(`${origin}/operacion/pulsoAtom/asset.js`)).text(), /custom = true/);
    assert.deepEqual(await (await fetch(`${origin}/operacion/pulsoAtom/api/probe?value=42`)).json(), { path: '/operacion/pulsoAtom/api/probe', value: '42' });
    const missing = await fetch(`${origin}/operacion/pulsoAtom/api/missing`, { headers: { Accept: 'text/html' } });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'API_NOT_FOUND' });
  } finally {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => backend.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  }
});
