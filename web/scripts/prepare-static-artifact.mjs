import { readFile, readdir, lstat, realpath, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIC_FORMAT, STATIC_BASE, sha256, readStaticArtifact } from '../../api/scripts/install-web-static.js';

// Run after the normal web build. Nothing here connects to production.
export async function prepareStaticArtifact({ dist, output, expectedIndexSha256 }) {
  if (!/^[a-f0-9]{64}$/.test(expectedIndexSha256 || '')) throw new Error('A verified production index SHA256 is required.');
  dist = path.resolve(dist); output = path.resolve(output);
  const distInfo = await lstat(dist);
  if (!distInfo.isDirectory() || distInfo.isSymbolicLink() || await realpath(dist) !== dist) throw new Error('Unsafe build directory.');
  const files = [];
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory() && relative === 'assets') await walk(path.join(directory, entry.name), 'assets/');
      else {
        if (!entry.isFile() || !/^(?:index\.html|assets\/[A-Za-z0-9_-]+\.(?:js|css|woff2?|png|jpe?g|svg|ico|webp))$/.test(relative)) throw new Error('Unexpected build file: ' + relative);
        const content = await readFile(path.join(directory, entry.name));
        files.push({ path: relative, sha256: sha256(content), content });
      }
    }
  }
  await walk(dist);
  // Output must be new: never overwrite an already reviewed artifact.
  await mkdir(output, { mode: 0o755 });
  await mkdir(path.join(output, 'assets'), { mode: 0o755 });
  files.sort((a, b) => a.path.localeCompare(b.path));
  for (const file of files) await writeFile(path.join(output, file.path), file.content, { flag: 'wx', mode: 0o644 });
  await writeFile(path.join(output, 'artifact.json'), JSON.stringify({ format: STATIC_FORMAT, basePath: STATIC_BASE,
    expectedIndexSha256, files: files.map(({ path: filename, sha256: hash }) => ({ path: filename, sha256: hash })) }, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  const artifact = await readStaticArtifact(output);
  return { files: artifact.files.size, bytes: artifact.bytes, indexSha256: artifact.files.get('index.html').sha256 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--expected-index-sha256') throw new Error('Use --expected-index-sha256 <verified current production index hash>.');
  const web = fileURLToPath(new URL('../', import.meta.url));
  console.log(JSON.stringify(await prepareStaticArtifact({ dist: path.join(web, 'dist'), output: path.join(web, 'temporary-static'), expectedIndexSha256: args[1] })));
}
