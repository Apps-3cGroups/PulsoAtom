import { readFile, readdir, lstat, mkdir, realpath, writeFile, rename, unlink, open, link, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This command only adds static web assets and atomically replaces the portal
// index. It never imports runtime configuration, connects to a DB, or restarts a process.
export const STATIC_FORMAT = 'pulso-web-static-v1';
export const STATIC_BASE = '/pulsoAtom';
const productionRoot = '/var/www/nodeapps/PulsoAtom';
const hashPattern = /^[a-f0-9]{64}$/;
const assetPattern = /^assets\/[A-Za-z0-9_-]+\.(?:js|css|woff2?|png|jpe?g|svg|ico|webp)$/;
export const sha256 = content => createHash('sha256').update(content).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
async function ordinaryDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) fail('UNSAFE_STATIC_DIRECTORY');
}
async function ordinaryFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(filename) !== filename) fail('UNSAFE_STATIC_FILE');
  return readFile(filename);
}
export function validatePortalIndex(content, files) {
  const html = content.toString('utf8');
  if (!html.includes('<title>Pulso · Conversaciones que importan</title>')
      || !/<div\s+id="root"\s*>\s*<\/div>/.test(html)
      || !/<script\s+type="module"[^>]+src="\/pulsoAtom\/assets\/[A-Za-z0-9_-]+\.js"/.test(html)) fail('NOT_PULSO_PORTAL_INDEX');
  const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  if (!references.length || references.some(value => !value.startsWith(`${STATIC_BASE}/`)
      || !assetPattern.test(value.slice(STATIC_BASE.length + 1))
      || (files && !files.has(value.slice(STATIC_BASE.length + 1))))) fail('INVALID_STATIC_INDEX_REFERENCE');
}
export async function readStaticArtifact(source) {
  source = path.resolve(source);
  await ordinaryDirectory(source);
  const manifestContent = await ordinaryFile(path.join(source, 'artifact.json'));
  if (manifestContent.length > 200_000) fail('INVALID_STATIC_MANIFEST');
  const manifest = JSON.parse(manifestContent);
  if (manifest.format !== STATIC_FORMAT || manifest.basePath !== STATIC_BASE
      || !hashPattern.test(manifest.expectedIndexSha256 || '')
      || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 500) fail('INVALID_STATIC_MANIFEST');
  const files = new Map(); let bytes = 0;
  for (const file of manifest.files) {
    if (!file || (file.path !== 'index.html' && !assetPattern.test(file.path))
        || files.has(file.path) || !hashPattern.test(file.sha256 || '')) fail('INVALID_STATIC_ASSET');
    const content = await ordinaryFile(path.join(source, file.path)); bytes += content.length;
    if (bytes > 50_000_000 || sha256(content) !== file.sha256) fail('STATIC_CHECKSUM_MISMATCH');
    files.set(file.path, { ...file, content });
  }
  if (!files.has('index.html')) fail('INVALID_STATIC_BUNDLE');
  async function inventory(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory() && relative === 'assets') {
        await ordinaryDirectory(path.join(directory, entry.name));
        await inventory(path.join(directory, entry.name), 'assets/');
      } else if (!entry.isFile() || (relative !== 'artifact.json' && !files.has(relative))) fail('UNEXPECTED_STATIC_FILE');
    }
  }
  await inventory(source);
  validatePortalIndex(files.get('index.html').content, files);
  return { manifest, manifestContent, files, bytes };
}

// root/source injection is for local filesystem tests. The executable below
// fixes both paths; workflow inputs cannot redirect installation elsewhere.
export async function installWebStatic({ root, source }) {
  root = path.resolve(root);
  const web = path.join(root, 'web'), dist = path.join(web, 'dist');
  for (const directory of [root, web, dist, path.join(dist, 'assets')]) await ordinaryDirectory(directory);
  const artifact = await readStaticArtifact(source);
  const { manifest, manifestContent, files, bytes } = artifact;
  const lockPath = path.join(web, '.static-install.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  const installId = randomUUID();
  const staged = new Set();
  try {
    await lock.writeFile(installId);
    const indexPath = path.join(dist, 'index.html');
    const oldIndex = await ordinaryFile(indexPath);
    validatePortalIndex(oldIndex);
    if (sha256(oldIndex) !== manifest.expectedIndexSha256) fail('STATIC_TARGET_CHANGED');
    // Check every collision before adding any asset. Content-addressed names
    // may be shared, but never overwritten with different bytes.
    const additions = [];
    for (const [relative, file] of files) {
      if (relative === 'index.html') continue;
      const destination = path.join(dist, relative);
      try {
        if (sha256(await ordinaryFile(destination)) !== file.sha256) fail('STATIC_ASSET_CONFLICT');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        additions.push([destination, file]);
      }
    }
    const backupRoot = path.join(web, '.static-backups');
    try { await mkdir(backupRoot, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await ordinaryDirectory(backupRoot);
    const backup = path.join(backupRoot, installId);
    await mkdir(backup, { mode: 0o700 });
    await writeFile(path.join(backup, 'index.html'), oldIndex, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(backup, 'artifact.json'), manifestContent, { flag: 'wx', mode: 0o600 });
    for (const [destination, file] of additions) {
      const temporary = path.join(dist, 'assets', `.static-${installId}-${path.basename(destination)}`);
      staged.add(temporary);
      await writeFile(temporary, file.content, { flag: 'wx', mode: 0o644 });
      await chmod(temporary, 0o644);
      // link() fails if another writer introduced the name; no overwrite race.
      await link(temporary, destination);
      await unlink(temporary); staged.delete(temporary);
    }
    const temporaryIndex = path.join(dist, `.index-static-${installId}.html`);
    staged.add(temporaryIndex);
    await writeFile(temporaryIndex, files.get('index.html').content, { flag: 'wx', mode: 0o644 });
    await chmod(temporaryIndex, 0o644);
    // Refuse a stale artifact even if a separate deployment ran during staging.
    if (sha256(await ordinaryFile(indexPath)) !== manifest.expectedIndexSha256) fail('STATIC_TARGET_CHANGED');
    await rename(temporaryIndex, indexPath); staged.delete(temporaryIndex);
    return { installed: true, path: `${STATIC_BASE}/`, installId, files: files.size, addedAssets: additions.length, bytes,
      beforeIndexSha256: manifest.expectedIndexSha256, indexSha256: files.get('index.html').sha256,
      applicationRestarted: false, workerChanged: false, monitorPreserved: true };
  } finally {
    for (const temporary of staged) await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { console.error(JSON.stringify({ installed: false, code: 'UNEXPECTED_STATIC_ARGUMENTS' })); process.exitCode = 1; }
  else installWebStatic({ root: productionRoot, source: fileURLToPath(new URL('../../static-web/', import.meta.url)) })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(JSON.stringify({ installed: false, code: error.code || 'STATIC_INSTALL_FAILED' })); process.exitCode = 1; });
}
