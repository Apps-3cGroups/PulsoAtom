import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('el instalador manual del monitor conserva sus controles y no ejecuta evaluaciones ni reinicia procesos', async () => {
  const installer = await readFile(new URL('../../api/scripts/install-daily-monitor.js', import.meta.url), 'utf8');
  assert.doesNotMatch(installer, /from ['"].*(?:store|mysql|evaluation-service)|child_process|pm2|execSync|spawn\(/);
  assert.match(installer, /MONITOR_CHECKSUM_MISMATCH/);
  assert.match(installer, /MONITOR_TARGET_NOT_OWNED/);
  assert.match(installer, /rename\(staging, target\)/);
});
