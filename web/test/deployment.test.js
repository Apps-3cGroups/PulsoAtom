import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer, loadConfigFromFile } from 'vite';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('Vite recarga el resumen sin barra final conservando fechas y subrutas configurables', async () => {
  for (const basePath of ['/pulsoAtom', '/operacion/pulsoAtom']) {
    const overrides = { VITE_BASE_PATH: basePath, VITE_API_BASE_URL: `${basePath}/api` };
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    const cacheDir = await mkdtemp(join(tmpdir(), 'pulso-vite-routing-'));
    Object.assign(process.env, overrides);
    let server;
    try {
      const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, fileURLToPath(new URL('../vite.config.js', import.meta.url)), webRoot);
      const seen = [];
      const probe = {
        name: 'request-path-probe',
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            seen.push(req.url);
            if (req.url.startsWith(`${basePath}/api/`)) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ path: req.url }));
              return;
            }
            next();
          });
        },
      };
      server = await createViteServer({ ...config, configFile: false, root: webRoot, cacheDir, logLevel: 'silent',
        plugins: [...config.plugins, probe], optimizeDeps: { noDiscovery: true, include: [] },
        server: { ...config.server, host: '127.0.0.1', port: 0, strictPort: false, proxy: {} },
      });
      await server.listen();
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      const query = '?from=2026-10-01&to=2026-11-03&variable=cliente%5Fmolesto';
      for (const path of [basePath, `${basePath}${query}`, `${basePath}/${query}`, `${basePath}/conversacion/123${query}`]) {
        const response = await fetch(`${origin}${path}`, { headers: { Accept: 'text/html' } });
        assert.equal(response.status, 200, path);
        assert.match(await response.text(), /<div id="root"><\/div>/, path);
      }
      assert.ok(seen.includes(`${basePath}/${query}`), 'El middleware conserva íntegra la consulta de fechas');
      const apiPath = `${basePath}/api/summary${query}`;
      assert.deepEqual(await (await fetch(`${origin}${apiPath}`)).json(), { path: apiPath });
      assert.equal((await fetch(`${origin}${basePath}-otro${query}`)).status, 404);
    } finally {
      await server?.close();
      await rm(cacheDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
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

test('la web abre PORT cuando PM2 importa el servidor mediante pm_exec_path', async t => {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const serverUrl = new URL('../server.js', import.meta.url);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(serverUrl.href)});`], {
    cwd: webRoot,
    env: { ...process.env, PORT: String(port), WEB_HOST: '127.0.0.1', pm_exec_path: fileURLToPath(serverUrl) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
  });
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('El servidor no abrió PORT al importarse como lo hace PM2')), 5000);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`El servidor terminó sin abrir PORT (exit ${code})`)));
      child.stdout.on('data', chunk => { if (chunk.toString().includes('Pulso:')) resolve(); });
      child.stderr.on('data', chunk => { if (chunk.toString().includes('Error:')) reject(new Error(chunk.toString())); });
    });
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
  } finally {
    clearTimeout(timer);
  }
});
