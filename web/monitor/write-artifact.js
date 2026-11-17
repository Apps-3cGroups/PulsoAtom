import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const output = fileURLToPath(new URL('../temporary-daily', import.meta.url));
const files = [];
for (const entry of await readdir(output, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const absolute = path.join(entry.parentPath || entry.path, entry.name);
  const relative = path.relative(output, absolute).split(path.sep).join('/');
  if (relative === 'artifact.json') continue;
  if (relative !== 'index.html' && !/^assets\/[A-Za-z0-9_-]+\.(js|css|woff2)$/.test(relative)) throw new Error(`Unsupported artifact entry: ${relative}`);
  const content = await readFile(absolute);
  files.push({ path: relative, sha256: createHash('sha256').update(content).digest('hex') });
}
if (!files.some(file => file.path === 'index.html') || files.length > 60) throw new Error('Invalid monitor artifact.');
files.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(path.join(output, 'artifact.json'), `${JSON.stringify({ format: 'pulso-daily-monitor-v1', files }, null, 2)}\n`);
console.log(`Monitor artifact verified: ${files.length} files.`);
