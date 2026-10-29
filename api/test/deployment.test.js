import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { DemoStore, UnconfiguredStore } from '../src/store.js';

const apiRoot = fileURLToPath(new URL('../', import.meta.url));
const settings = { demo: true, origin: 'http://127.0.0.1:3000', sessionHours: 8, secureCookie: false, timezone: 'America/Tegucigalpa' };

test('BASE_PATH normaliza la subruta y PORT tiene prioridad sobre API_PORT para PM2', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    "const { config } = await import('./src/config.js'); console.log(JSON.stringify({ basePath: config.basePath, port: config.port }));"], {
    cwd: apiRoot, encoding: 'utf8', env: { ...process.env, BASE_PATH: '/operacion/pulsoAtom/', PORT: '4311', API_PORT: '9999' },
  });
  assert.deepEqual(JSON.parse(output.trim()), { basePath: '/operacion/pulsoAtom', port: 4311 });
});

test('la API inicia con la subruta /pulsoAtom solicitada', async () => {
  const app = createApp(new UnconfiguredStore(), { ...settings, demo: false });
  await request(app).get('/pulsoAtom/api/meta').expect(200);
  await request(app).get('/pulso/api/meta').expect(404);
  await request(app).get('/api/meta').expect(404);
});

test('login, sesión y logout usan la subruta configurada y la misma ruta de cookie', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pulso-path-test-'));
  const store = await new DemoStore(path.join(directory, 'state.json')).init();
  const app = createApp(store, { ...settings, basePath: '/operacion/pulsoAtom/' });
  const agent = request.agent(app);
  try {
    await agent.get('/operacion/pulsoAtom/api/health').expect(200);
    await agent.get('/pulsoAtom/api/health').expect(404);
    const login = await agent.post('/operacion/pulsoAtom/api/auth/demo').set('Origin', settings.origin).send({ role: 'admin' }).expect(200);
    assert.match(login.headers['set-cookie'][0], /Path=\/operacion\/pulsoAtom(?:;|$)/);
    await agent.get('/operacion/pulsoAtom/api/auth/me').expect(200);
    const logout = await agent.post('/operacion/pulsoAtom/api/auth/logout').set('Origin', settings.origin).send({}).expect(204);
    assert.match(logout.headers['set-cookie'][0], /Path=\/operacion\/pulsoAtom(?:;|$)/);
    await agent.get('/operacion/pulsoAtom/api/auth/me').expect(401);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('la API rechaza montar el portal en la raíz del dominio', () => {
  assert.throws(() => createApp(new UnconfiguredStore(), { ...settings, basePath: '/' }), /subruta/i);
});
