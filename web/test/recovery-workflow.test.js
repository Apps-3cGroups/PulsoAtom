import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const workflowPath = new URL('../../.github/workflows/deploy-pulso-atom.yml', import.meta.url);

test('two-worker recovery is an explicit deployed-only operation with fixed arguments and no API restart', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const operation = 'tuesday-wednesday-start-two';
  const options = workflow.match(/options: \[([^\]]+)\]/)?.[1].split(',').map(value => value.trim());
  const allowed = workflow.match(/\$env:GEMMA_OPERATION -cnotin @\(([^)]+)\)/)?.[1];
  const job = workflow.match(/gemma-check:\n\s+if: ([^\n]+)/)?.[1];
  assert.ok(options.includes(operation));
  assert.ok(allowed.includes(`'${operation}'`));
  assert.ok(job.includes(`inputs.operation == '${operation}'`));
  for (const readonly of [
    workflow.match(/\$useCheckoutSource = \$env:GEMMA_OPERATION -cin @\(([^)]+)\)/)?.[1],
    workflow.match(/uses: actions\/checkout@v4\n\s+if: ([^\n]+)/)?.[1],
  ]) assert.ok(readonly && !readonly.includes(operation));
  const mapping = workflow.split('\n').find(line => line.trim().startsWith(`'${operation}' {`));
  assert.equal(mapping.trim(), "'tuesday-wednesday-start-two' { $entryScript = 'scripts/complete-tuesday-wednesday.js'; $scriptArguments = '--start --concurrency=2' }");
  const production = workflow.match(/\$remoteCommand = @'\n([\s\S]*?)\n {10}'@/)?.[1];
  const launch = production.indexOf('exec node');
  for (const guard of ['"$actual_sha" = "__EXPECTED_SHA__"', 'git -C /var/www/nodeapps/PulsoAtom diff --quiet HEAD -- api']) {
    assert.ok(production.indexOf(guard) >= 0 && production.indexOf(guard) < launch);
  }
  const restartBlock = production.match(/if \[ '__OPERATION__' = 'gemma-tuesday-recover' \]; then\n[\s\S]*?\n\s+fi/);
  assert.ok(restartBlock);
  assert.doesNotMatch(production.replace(restartBlock[0], ''), /pm2/);
  assert.equal(workflow.match(/\n  deploy:\n\s+if: ([^\n]+)/)?.[1], "${{ github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.operation == 'deploy') }}");
});

