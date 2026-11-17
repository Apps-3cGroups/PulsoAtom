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

test('Thursday handoff separates isolated inspection from guarded preparation', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const options = workflow.match(/options: \[([^\]]+)\]/)?.[1].split(',').map(value => value.trim());
  const allowed = workflow.match(/\$env:GEMMA_OPERATION -cnotin @\(([^)]+)\)/)?.[1];
  const job = workflow.match(/gemma-check:\n\s+if: ([^\n]+)/)?.[1];
  const checkoutOperations = workflow.match(/\$useCheckoutSource = \$env:GEMMA_OPERATION -cin @\(([^)]+)\)/)?.[1];
  const checkoutCondition = workflow.match(/uses: actions\/checkout@v4\n\s+if: ([^\n]+)/)?.[1];
  for (const verb of ['inspect', 'prepare']) {
    const operation = `thursday-handoff-${verb}`;
    assert.ok(options.includes(operation));
    assert.ok(allowed.includes(`'${operation}'`));
    assert.ok(job.includes(`inputs.operation == '${operation}'`));
    assert.equal(checkoutOperations.includes(`'${operation}'`), verb === 'inspect');
    assert.equal(checkoutCondition.includes(`inputs.operation == '${operation}'`), verb === 'inspect');
  }
  assert.ok(workflow.includes("'thursday-handoff-inspect' { $entryScript = 'scripts/prepare-thursday-handoff.js'; $scriptArguments = '--inspect' }"));
  assert.ok(workflow.includes("'thursday-handoff-prepare' { $entryScript = 'scripts/prepare-thursday-handoff.js'; $scriptArguments = \"--prepare --expected-version $($env:EXPECTED_SETTINGS_VERSION) --expected-scope-hash $($env:EXPECTED_SCOPE_HASH) --concurrency $($env:HANDOFF_CONCURRENCY)\" }"));
  assert.match(workflow, /EXPECTED_SCOPE_HASH: \$\{\{ inputs\.expected_scope_hash \}\}/);
  assert.match(workflow, /HANDOFF_CONCURRENCY: \$\{\{ inputs\.handoff_concurrency \}\}/);
  assert.match(workflow, /handoff_concurrency:\n\s+description: [^\n]+\n\s+type: choice\n\s+options: \['1', '2'\]\n\s+default: '1'/);
});

test('Thursday preparation rejects missing, malformed and injected version, scope hash or concurrency', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const block = workflow.match(/if \(\$env:GEMMA_OPERATION -ceq 'thursday-handoff-prepare'\) \{([\s\S]*?)^ {10}\}/m);
  assert.ok(block);
  assert.ok(workflow.indexOf(block[0]) < workflow.indexOf('switch -CaseSensitive ($env:GEMMA_OPERATION)'));
  const expressions = Object.fromEntries(['EXPECTED_SETTINGS_VERSION', 'EXPECTED_SCOPE_HASH', 'HANDOFF_CONCURRENCY'].map(variable => {
    const pattern = block[1].match(new RegExp(`\\$env:${variable} -cnotmatch '([^']+)'`))?.[1];
    assert.ok(pattern, `Missing validation for ${variable}`);
    return [variable, new RegExp(pattern)];
  }));
  const examples = [
    ['EXPECTED_SETTINGS_VERSION', ['1', '18', '999999999999999'], ['', '0', '-1', '1.5', '1000000000000000', '18\n', '18 --start', '$(id)', '18; id']],
    ['EXPECTED_SCOPE_HASH', ['a'.repeat(64), '0'.repeat(64)], ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(64)}\n`, `${'a'.repeat(64)} --start`, '$(id)']],
    ['HANDOFF_CONCURRENCY', ['1', '2'], ['', '0', '3', '02', '2.0', '2\n', '2 --start', '2; id', '$(id)']],
  ];
  for (const [variable, accepted, rejected] of examples) {
    for (const value of accepted) assert.equal(expressions[variable].test(value), true, `${variable}: accepts ${JSON.stringify(value)}`);
    for (const value of rejected) assert.equal(expressions[variable].test(value), false, `${variable}: rejects ${JSON.stringify(value)}`);
  }
});

