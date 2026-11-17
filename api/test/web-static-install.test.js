import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installWebStatic, sha256, readStaticArtifact } from '../scripts/install-web-static.js';
import { prepareStaticArtifact } from '../../web/scripts/prepare-static-artifact.mjs';

const html = (name = 'new') => `<!doctype html><html><head><title>Pulso · Conversaciones que importan</title><script type="module" crossorigin src="/pulsoAtom/assets/${name}.js"></script><link href="/pulsoAtom/assets/shared.css" rel="stylesheet"></head><body><div id="root"></div></body></html>`;
async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pulso-static-'));
  // macOS /var is a symlink. Installer intentionally requires canonical paths.
  const { realpath } = await import('node:fs/promises');
  const base = await realpath(temporary);
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'production'), dist = path.join(root, 'web/dist'), source = path.join(base, 'artifact'), build = path.join(base, 'build');
  for (const directory of [path.join(dist, 'assets'), path.join(dist, 'monitor-evaluaciones/assets'), path.join(root, 'api/node_modules'), path.join(build, 'assets')]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(dist, 'index.html'), html('old'));
  await writeFile(path.join(dist, 'assets/old.js'), 'old javascript');
  await writeFile(path.join(dist, 'assets/shared.css'), 'body {}');
  await writeFile(path.join(dist, 'monitor-evaluaciones/index.html'), 'running monitor');
  await writeFile(path.join(dist, 'monitor-evaluaciones/assets/monitor.js'), 'monitor javascript');
  await writeFile(path.join(root, 'api/node_modules/sentinel'), 'do not touch');
  await writeFile(path.join(root, 'web/server.js'), 'do not restart');
  await writeFile(path.join(build, 'index.html'), html());
  await writeFile(path.join(build, 'assets/new.js'), 'new javascript');
  await writeFile(path.join(build, 'assets/shared.css'), 'body {}');
  const result = await prepareStaticArtifact({ dist: build, output: source, expectedIndexSha256: sha256(html('old')) });
  return { base, root, dist, source, build, result };
}
async function mutateManifest(source, change) {
  const filename = path.join(source, 'artifact.json');
  const manifest = JSON.parse(await readFile(filename, 'utf8')); change(manifest);
  await writeFile(filename, JSON.stringify(manifest));
}
async function unchanged(f) {
  assert.equal(await readFile(path.join(f.dist, 'index.html'), 'utf8'), html('old'));
  assert.equal(await readFile(path.join(f.dist, 'assets/old.js'), 'utf8'), 'old javascript');
  assert.equal(await readFile(path.join(f.dist, 'monitor-evaluaciones/index.html'), 'utf8'), 'running monitor');
}
test('installs main portal index last, backs up old entry, preserves monitor and old/shared assets', async t => {
  const f = await fixture(t);
  const result = await installWebStatic(f);
  assert.equal(result.installed, true); assert.equal(result.addedAssets, 1);
  assert.equal(result.applicationRestarted, false); assert.equal(result.workerChanged, false);
  assert.equal(await readFile(path.join(f.dist, 'index.html'), 'utf8'), html());
  assert.equal(await readFile(path.join(f.dist, 'assets/old.js'), 'utf8'), 'old javascript');
  assert.equal(await readFile(path.join(f.dist, 'assets/new.js'), 'utf8'), 'new javascript');
  assert.equal(await readFile(path.join(f.dist, 'monitor-evaluaciones/index.html'), 'utf8'), 'running monitor');
  assert.equal(await readFile(path.join(f.dist, 'monitor-evaluaciones/assets/monitor.js'), 'utf8'), 'monitor javascript');
  assert.equal(await readFile(path.join(f.root, 'api/node_modules/sentinel'), 'utf8'), 'do not touch');
  assert.equal(await readFile(path.join(f.root, 'web/server.js'), 'utf8'), 'do not restart');
  assert.equal(await readFile(path.join(f.root, 'web/.static-backups', result.installId, 'index.html'), 'utf8'), html('old'));
  assert.equal((await lstat(path.join(f.dist, 'index.html'))).mode & 0o777, 0o644);
  assert.deepEqual((await readdir(path.join(f.root, 'web'))).sort(), ['.static-backups', 'dist', 'server.js']);
});
test('stale production index hash refuses all mutations', async t => {
  const f = await fixture(t); await mutateManifest(f.source, m => { m.expectedIndexSha256 = '0'.repeat(64); });
  await assert.rejects(installWebStatic(f), { code: 'STATIC_TARGET_CHANGED' }); await unchanged(f);
  await assert.rejects(readFile(path.join(f.dist, 'assets/new.js')), { code: 'ENOENT' });
});
test('conflicting existing asset is never overwritten, even if listed after a new asset', async t => {
  const f = await fixture(t); await writeFile(path.join(f.dist, 'assets/shared.css'), 'existing different css');
  await assert.rejects(installWebStatic(f), { code: 'STATIC_ASSET_CONFLICT' }); await unchanged(f);
  assert.equal(await readFile(path.join(f.dist, 'assets/shared.css'), 'utf8'), 'existing different css');
  await assert.rejects(readFile(path.join(f.dist, 'assets/new.js')), { code: 'ENOENT' });
});
test('rejects changed bytes before installation', async t => {
  const f = await fixture(t); await writeFile(path.join(f.source, 'assets/new.js'), 'changed');
  await assert.rejects(installWebStatic(f), { code: 'STATIC_CHECKSUM_MISMATCH' }); await unchanged(f);
});
test('rejects foreign target index even with matching expected hash', async t => {
  const f = await fixture(t); const foreign = html('old').replace('Pulso · Conversaciones que importan', 'Other portal');
  await writeFile(path.join(f.dist, 'index.html'), foreign);
  await mutateManifest(f.source, m => { m.expectedIndexSha256 = sha256(foreign); });
  await assert.rejects(installWebStatic(f), { code: 'NOT_PULSO_PORTAL_INDEX' });
  assert.equal(await readFile(path.join(f.dist, 'index.html'), 'utf8'), foreign);
});
test('rejects wrong base path or a missing entry reference', async t => {
  const f = await fixture(t); await mutateManifest(f.source, m => { m.basePath = '/another'; });
  await assert.rejects(installWebStatic(f), { code: 'INVALID_STATIC_MANIFEST' }); await unchanged(f);
  await mutateManifest(f.source, m => { m.basePath = '/pulsoAtom'; m.files = m.files.filter(x => x.path !== 'assets/new.js'); });
  await rm(path.join(f.source, 'assets/new.js'));
  await assert.rejects(installWebStatic(f), { code: 'INVALID_STATIC_INDEX_REFERENCE' }); await unchanged(f);
});
test('rejects unexpected files, traversal, links in source or target', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, '.env'), 'not a deployable file');
  await assert.rejects(installWebStatic(f), { code: 'UNEXPECTED_STATIC_FILE' }); await rm(path.join(f.source, '.env'));
  await mutateManifest(f.source, m => { m.files.push({ path: '../server.js', sha256: '0'.repeat(64) }); });
  await assert.rejects(installWebStatic(f), { code: 'INVALID_STATIC_ASSET' });
  await mutateManifest(f.source, m => { m.files.pop(); });
  await rm(path.join(f.source, 'assets/new.js')); await symlink(path.join(f.build, 'assets/new.js'), path.join(f.source, 'assets/new.js'));
  await assert.rejects(installWebStatic(f), { code: 'UNSAFE_STATIC_FILE' });
  await rm(path.join(f.source, 'assets/new.js')); await writeFile(path.join(f.source, 'assets/new.js'), 'new javascript');
  await symlink(path.join(f.build, 'assets/new.js'), path.join(f.dist, 'assets/new.js'));
  await assert.rejects(installWebStatic(f), { code: 'UNSAFE_STATIC_FILE' }); await unchanged(f);
});
test('existing installation lock prevents concurrent install and remains owned by its creator', async t => {
  const f = await fixture(t); const lock = path.join(f.root, 'web/.static-install.lock'); await writeFile(lock, 'other install');
  await assert.rejects(installWebStatic(f), { code: 'EEXIST' }); await unchanged(f);
  assert.equal(await readFile(lock, 'utf8'), 'other install');
});
test('artifact writer validates checksum and never overwrites reviewed output', async t => {
  const f = await fixture(t); const artifact = await readStaticArtifact(f.source);
  assert.equal(artifact.files.size, 3); assert.equal(f.result.indexSha256, sha256(html()));
  await assert.rejects(prepareStaticArtifact({ dist: f.build, output: f.source, expectedIndexSha256: sha256(html('old')) }), { code: 'EEXIST' });
});
test('workflow web-static-install is isolated and cannot select the full deploy job', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/deploy-pulso-atom.yml', import.meta.url), 'utf8');
  for (const pattern of [/options: \[([^\]]+)\]/, /\$env:GEMMA_OPERATION -cnotin @\(([^)]+)\)/, /\$useCheckoutSource = \$env:GEMMA_OPERATION -cin @\(([^)]+)\)/,
    /gemma-check:\n\s+if: ([^\n]+)/, /uses: actions\/checkout@v4\n\s+if: ([^\n]+)/]) assert.ok(workflow.match(pattern)?.[1].includes('web-static-install'));
  assert.match(workflow, /'web-static-install' \{ \$entryScript = 'scripts\/install-web-static\.js'; \$scriptArguments = '' \}/);
  assert.match(workflow, /web\/temporary-static/); assert.match(workflow, /\$remoteRoot\/static-web/);
  const staticBranch = workflow.match(/if \[ '\$env:GEMMA_OPERATION' = 'web-static-install' \]; then([\s\S]*?)\n {10}else/)?.[1];
  assert.ok(staticBranch); assert.match(staticBranch, /exec node scripts\/install-web-static\.js/);
  assert.doesNotMatch(staticBranch, /--env-file|node_modules|pm2|npm|git|\.env/);
  assert.equal(workflow.match(/\n  deploy:\n\s+if: ([^\n]+)/)?.[1], "${{ github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.operation == 'deploy') }}");
  assert.match(workflow, /push:\n\s+branches:\n\s+- main\n/);
  assert.match(workflow, /group: deploy-pulso-atom-production\n\s+cancel-in-progress: false/);
});
