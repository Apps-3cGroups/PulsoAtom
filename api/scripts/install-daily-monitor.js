import { readFile, readdir, lstat, mkdir, copyFile, rename, chmod, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Installs only the temporary static monitor. No database, model calls, worker
// changes, build, process restart or application deployment happens here.
const root = '/var/www/nodeapps/PulsoAtom';
const source = fileURLToPath(new URL('../../static-monitor/', import.meta.url));
const target = path.join(root, 'web/dist/monitor-evaluaciones');
const marker = 'pulso-daily-monitor-v1';
const fail = code => { throw Object.assign(new Error(code), { code }); };
async function ordinaryDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) fail('UNSAFE_MONITOR_DIRECTORY');
}
async function install() {
  for (const directory of [root, path.join(root, 'web'), path.join(root, 'web/dist'), source.replace(/\/$/, '')]) await ordinaryDirectory(directory);
  const manifestPath = path.join(source, 'artifact.json');
  if (!(await lstat(manifestPath)).isFile() || (await lstat(manifestPath)).isSymbolicLink()) fail('INVALID_MONITOR_MANIFEST');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.format !== marker || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 60) fail('INVALID_MONITOR_MANIFEST');
  const paths = new Set(); let bytes = 0;
  for (const file of manifest.files) {
    if (!/^(?:index\.html|assets\/[A-Za-z0-9_-]+\.(?:js|css|woff2))$/.test(file.path) || paths.has(file.path)
      || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('INVALID_MONITOR_ASSET');
    paths.add(file.path);
    const filename = path.join(source, file.path), info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(filename) !== filename) fail('UNSAFE_MONITOR_ASSET');
    const content = await readFile(filename); bytes += content.length;
    if (createHash('sha256').update(content).digest('hex') !== file.sha256) fail('MONITOR_CHECKSUM_MISMATCH');
  }
  if (!paths.has('index.html') || bytes > 5_000_000) fail('INVALID_MONITOR_BUNDLE');
  // Reject unexpected files rather than copying runtime files or credentials.
  async function inventory(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) fail('UNSAFE_MONITOR_ASSET');
      if (entry.isDirectory()) {
        if (relative !== 'assets') fail('UNEXPECTED_MONITOR_DIRECTORY');
        await inventory(path.join(dir, entry.name), relative + '/');
      } else if (relative !== 'artifact.json' && !paths.has(relative)) fail('UNEXPECTED_MONITOR_ASSET');
    }
  }
  await inventory(source);
  let previous = false;
  try { await lstat(target); previous = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    await ordinaryDirectory(target);
    let old;
    try {
      const markerPath = path.join(target, 'monitor-install.json');
      if ((await lstat(markerPath)).isSymbolicLink()) fail('MONITOR_TARGET_NOT_OWNED');
      old = JSON.parse(await readFile(markerPath, 'utf8'));
    } catch { fail('MONITOR_TARGET_NOT_OWNED'); }
    if (old.format !== marker) fail('MONITOR_TARGET_NOT_OWNED');
  }
  const installId = randomUUID(), staging = path.join(root, `web/dist/.monitor-evaluaciones-${installId}`);
  await mkdir(staging, { mode: 0o755 });
  for (const file of manifest.files) {
    const destination = path.join(staging, file.path);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await copyFile(path.join(source, file.path), destination); await chmod(destination, 0o644);
  }
  await writeFile(path.join(staging, 'monitor-install.json'), JSON.stringify({ format: marker, installedAt: new Date().toISOString() }), { mode: 0o644 });
  const backupRoot = path.join(root, 'api/.data/monitor-backups');
  const backup = path.join(backupRoot, installId);
  if (previous) {
    await mkdir(backupRoot, { recursive: true, mode: 0o700 }); await ordinaryDirectory(backupRoot);
    await rename(target, backup);
  }
  try { await rename(staging, target); }
  catch (error) { if (previous) await rename(backup, target); throw error; }
  console.log(JSON.stringify({ installed: true, path: '/pulsoAtom/monitor-evaluaciones/index.html', files: manifest.files.length,
    bytes, authentication: 'Existing Pulso administrator session; data only through authenticated API',
    applicationRestarted: false, workerChanged: false }));
}
install().catch(error => { console.error(JSON.stringify({ installed: false, code: error.code || 'MONITOR_INSTALL_FAILED' })); process.exitCode = 1; });
