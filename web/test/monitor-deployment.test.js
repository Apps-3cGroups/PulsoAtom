import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('la publicación del monitor instala solo el artefacto y no entra en el despliegue de la API', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/deploy-pulso-atom.yml', import.meta.url), 'utf8');
  const operation = 'daily-activity-monitor';
  for (const pattern of [/options: \[([^\]]+)\]/, /gemma-check:\n\s+if: ([^\n]+)/, /uses: actions\/checkout@v4\n\s+if: ([^\n]+)/,
    /\$env:GEMMA_OPERATION -cnotin @\(([^)]+)\)/, /\$useCheckoutSource = \$env:GEMMA_OPERATION -cin @\(([^)]+)\)/]) {
    assert.ok(workflow.match(pattern)?.[1].includes(operation));
  }
  assert.ok(workflow.includes("'daily-activity-monitor' { $entryScript = 'scripts/install-daily-monitor.js'; $scriptArguments = '' }"));
  assert.equal(workflow.match(/\n  deploy:\n\s+if: ([^\n]+)/)?.[1], "${{ github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.operation == 'deploy') }}");
  const installer = await readFile(new URL('../../api/scripts/install-daily-monitor.js', import.meta.url), 'utf8');
  assert.doesNotMatch(installer, /from ['"].*(?:store|mysql|evaluation-service)|child_process|pm2|execSync|spawn\(/);
  assert.match(installer, /MONITOR_CHECKSUM_MISMATCH/);
  assert.match(installer, /MONITOR_TARGET_NOT_OWNED/);
  assert.match(installer, /rename\(staging, target\)/);
});
