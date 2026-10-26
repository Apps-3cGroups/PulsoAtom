import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createWebServer } from '../server.js';

test('el servidor respeta /pulso, recarga rutas internas y conserva el prefijo de la API', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pulso-web-test-'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="es"><body>Pulso</body></html>');
  await writeFile(path.join(directory, 'asset.js'), 'const pulso = true;');
  const api = express();
  api.get('/pulso/api/probe', (_req, res) => res.json({ reached: true }));
  const backend = api.listen(0, '127.0.0.1');
  await new Promise(resolve => backend.once('listening', resolve));
  const server = createWebServer({ dist: directory, apiTarget: `http://127.0.0.1:${backend.address().port}` }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ['/pulso', '/pulso/catalogo', '/pulso/conversacion/DEMO-MX-0001', '/pulso/evaluaciones']) {
      const response = await fetch(`${origin}${route}`, { headers: { Accept: 'text/html' } });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<body>Pulso/);
    }
    assert.equal((await fetch(`${origin}/`)).status, 404);
    assert.equal((await fetch(`${origin}/api/probe`)).status, 404);
    assert.equal((await fetch(`${origin}/pulso/missing.js`)).status, 404);
    assert.match(await (await fetch(`${origin}/pulso/asset.js`)).text(), /pulso = true/);
    assert.deepEqual(await (await fetch(`${origin}/pulso/api/probe`)).json(), { reached: true });
  } finally {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => backend.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  }
});
