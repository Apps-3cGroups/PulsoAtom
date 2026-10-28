import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';

const webRoot = fileURLToPath(new URL('../', import.meta.url));

test('Vite alinea recursos, Router y API cuando se cambia la subruta', async () => {
  const overrides = { VITE_BASE_PATH: '/operacion/pulsoAtom/', VITE_API_BASE_URL: '/operacion/pulsoAtom/api/', PORT: '4310', WEB_PORT: '9999', API_PROXY_TARGET: 'http://127.0.0.1:4311' };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, fileURLToPath(new URL('../vite.config.js', import.meta.url)), webRoot);
    assert.equal(config.base, '/operacion/pulsoAtom/');
    assert.equal(config.define['import.meta.env.VITE_BASE_PATH'], '"/operacion/pulsoAtom"');
    assert.equal(config.define['import.meta.env.VITE_API_BASE_URL'], '"/operacion/pulsoAtom/api"');
    assert.equal(config.server.port, 4310);
    assert.equal(config.server.proxy['/operacion/pulsoAtom/api'].target, 'http://127.0.0.1:4311');
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('PM2 mantiene web y API separados, con cwd Linux y solo PORT en env', () => {
  const require = createRequire(import.meta.url);
  const { apps } = require('../../ecosystem.config.js');
  assert.equal(apps.length, 2);
  assert.equal(new Set(apps.map(app => app.name)).size, 2);
  assert.deepEqual(apps.map(app => app.cwd).sort(), ['/var/www/nodeapps/PulsoAtom/api', '/var/www/nodeapps/PulsoAtom/web']);
  for (const app of apps) {
    assert.equal(app.script, 'server.js');
    assert.deepEqual(Object.keys(app.env), ['PORT']);
    assert.ok(Number.isInteger(app.env.PORT) && app.env.PORT > 0 && app.env.PORT <= 65535);
  }
  assert.equal(new Set(apps.map(app => app.env.PORT)).size, 2);
});
