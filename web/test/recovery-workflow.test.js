import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workflowPath = new URL('../../.github/workflows/deploy-pulso-atom.yml', import.meta.url);

test('the workflow exposes deployment only, without recovery or model operations', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const jobs = workflow.split('\njobs:\n')[1];
  assert.ok(jobs, 'Missing workflow jobs');
  assert.deepEqual([...jobs.matchAll(/^ {2}([\w-]+):\s*$/gm)].map(match => match[1]), ['deploy']);
  assert.match(workflow, /push:\n\s+branches:\n\s+- main\n/);
  assert.match(workflow, /^ {2}workflow_dispatch:\s*\n\npermissions:/m);
  assert.doesNotMatch(workflow, /inputs\.|GEMMA_OPERATION|gemma-check|daily-activity-monitor|web-static-install/);
  assert.doesNotMatch(workflow, /scripts\/(?:complete-tuesday-wednesday|prepare-thursday-handoff|recover-tuesday-evaluations|start-next-local-batch|start-gemma-renewal|extend-gemma-renewal)\.(?:js|mjs)/);
});

test('deployment is restricted to main pushes or manual dispatches, with serialized read-only repository access', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const condition = workflow.match(/^ {2}deploy:\n\s+if: ([^\n]+)/m)?.[1];
  assert.equal(condition, "${{ github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}");
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  assert.match(workflow, /^concurrency:\n {2}group: deploy-pulso-atom-production\n {2}cancel-in-progress: false\n/m);
});

test('actual deployment preflight rejects invalid, changed or divergent revisions before modifying the checkout', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const script = workflow.match(/\$remoteScript = @'\n([\s\S]*?)\n {10}'@/)?.[1];
  assert.ok(script, 'Missing remote deployment script');
  const block = script.match(/ {10}\[\[ "\$TARGET_SHA" =~[^\n]+\n[\s\S]*?Deployed revision changed\."/);
  assert.ok(block, 'Missing exact-revision preflight and fast-forward block');
  const directory = await mkdtemp(path.join(tmpdir(), 'pulso-revision-check-'));
  const bin = path.join(directory, 'bin');
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), command = args.join(' ');
fs.appendFileSync(process.env.TEST_GIT_LOG, JSON.stringify(args) + '\\n');
if (command === 'rev-parse HEAD') {
  console.log(fs.existsSync(process.env.TEST_MERGED_MARKER) ? process.env.TEST_POST_HEAD : process.env.TEST_PREVIOUS_HEAD);
} else if (command === 'fetch origin main') {
  process.exit(Number(process.env.TEST_FETCH_EXIT));
} else if (command === 'rev-parse FETCH_HEAD') {
  console.log(process.env.TEST_REMOTE_HEAD);
} else if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
  process.exit(Number(process.env.TEST_ANCESTOR_EXIT));
} else if (args[0] === 'diff' && args[1] === '--quiet') {
  process.exit(1);
} else if (args[0] === 'merge' && args[1] === '--ff-only' && args[2] === process.env.TARGET_SHA) {
  fs.writeFileSync(process.env.TEST_MERGED_MARKER, 'merged');
} else process.exit(90);
`;
  const target = 'a'.repeat(40), previous = 'b'.repeat(40);
  try {
    await mkdir(bin);
    await writeFile(path.join(bin, 'git'), stub, { mode: 0o700 });
    const cases = [
      { name: 'valid fast-forward', success: true, merges: 1 },
      { name: 'invalid target', target: 'main; echo injected', merges: 0 },
      { name: 'main changed after dispatch', remote: 'c'.repeat(40), merges: 0 },
      { name: 'divergent production checkout', ancestorExit: 1, merges: 0 },
      { name: 'fetch failed', fetchExit: 1, merges: 0 },
      { name: 'unexpected revision after merge', post: 'd'.repeat(40), merges: 1 },
    ];
    for (const [index, scenario] of cases.entries()) {
      const log = path.join(directory, `${index}.jsonl`);
      await writeFile(log, '');
      const run = spawnSync('/bin/bash', ['-eu', '-o', 'pipefail', '-c',
        'fail() { echo "$*" >&2; exit 1; }\n' + block[0].replace(/^ {10}/gm, '')], {
        cwd: directory, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TARGET_SHA: scenario.target || target,
          TEST_GIT_LOG: log, TEST_MERGED_MARKER: path.join(directory, `${index}.merged`),
          TEST_PREVIOUS_HEAD: previous, TEST_REMOTE_HEAD: scenario.remote || target,
          TEST_POST_HEAD: scenario.post || target, TEST_ANCESTOR_EXIT: String(scenario.ancestorExit || 0),
          TEST_FETCH_EXIT: String(scenario.fetchExit || 0) },
      });
      assert.ifError(run.error);
      assert.equal(run.status === 0, !!scenario.success, `${scenario.name}: ${run.stderr}`);
      const calls = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.equal(calls.filter(args => args[0] === 'merge').length, scenario.merges, scenario.name);
      if (scenario.name === 'invalid target') assert.deepEqual(calls, [], 'Reject injection before invoking Git');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
