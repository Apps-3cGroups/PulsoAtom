import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { createGemmaBackfillPlan } from '../src/gemma-backfill.js';
import { parseGemmaRenewalArguments, startGemmaRenewal, gemmaRenewalStatus } from '../scripts/start-gemma-renewal.js';

const maintenanceId = 'aabb1122-3344-5566-7788-aabbccddeeff';
const sha = text => createHash('sha256').update(text).digest('hex');
const expectedArgs = ['--expected-evaluations', '2', '--expected-policy-version', '6',
  '--expected-configuration-hash', 'a'.repeat(64), '--expected-catalog-hash', 'b'.repeat(64), '--expected-prompt-hash', 'c'.repeat(64),
  '--from', '2026-11-02', '--to', '2026-11-06', '--limit', '20'];
const selection = { from: '2026-11-02', to: '2026-11-06', timezone: 'America/Tegucigalpa', basis: 'last_activity', limit: 20 };

async function fixture(t) {
  const apiDirectory = await mkdtemp(path.join(os.tmpdir(), 'pulso-renewal-unit-'));
  t.after(() => rm(apiDirectory, { recursive: true, force: true }));
  for (const filename of ['scripts/start-gemma-renewal.js', 'scripts/reset-evaluations.js', 'scripts/evaluate-all.js',
    'src/gemma-backfill.js', 'src/evaluation-service.js', 'src/evaluator.js', 'src/gateway-evaluator.js', 'src/evaluation-reset-safety.js']) {
    await mkdir(path.dirname(path.join(apiDirectory, filename)), { recursive: true });
    await writeFile(path.join(apiDirectory, filename), '// synthetic fixture source');
  }
  const state = createState(false);
  state.settings.aiPolicy = { mode: 'single', primaryId: 'gemma-local', secondaryId: null, fallbackId: null, version: 6 };
  state.settings.dailyEnabled = false;
  state.evaluations = [{ id: 'synthetic-old-1' }, { id: 'synthetic-old-2' }];
  state.conversations = [{ id: 'synthetic-conversation', country: 'HN', completed: true,
    messages: [{ id: 'synthetic-message', actor: 'cliente', text: 'PRIVATE_SYNTHETIC_CONTENT', timestamp: '2026-11-06T10:00:00.000Z' }] }];
  const calls = { reads: 0, reset: 0, launch: 0, ai: 0 };
  const registry = new ModelRegistry([{ id: 'gemma-local', label: 'Gemma', provider: 'gateway', model: 'synthetic-gemma', enabled: true,
    evaluator: { configured: true, async evaluate() { calls.ai++; assert.fail('The wrapper must never directly evaluate'); } } }]);
  const store = { async readWithConversations(options) { calls.reads++; assert.deepEqual(options, { fresh: true }); return structuredClone(state); },
    async read() { calls.reads++; return structuredClone(state); }, async transaction() { assert.fail('The wrapper must not mutate the database directly'); } };
  const plan = createGemmaBackfillPlan(state, registry);
  const expected = { evaluations: 2, policyVersion: 6, configurationHash: plan.profile.configurationHash,
    catalogHash: plan.conversations[0].catalogHash, promptHash: plan.conversations[0].promptHash };
  const reset = async ({ expected: checked }) => {
    calls.reset++; assert.deepEqual(checked, expected);
    const directory = path.join(apiDirectory, '.data/backups'); await mkdir(directory, { recursive: true });
    const backup = path.join(directory, `evaluations-synthetic-${maintenanceId}.json`), text = JSON.stringify({ synthetic: true });
    await writeFile(backup, text, { mode: 0o600 }); await writeFile(`${backup}.sha256`, sha(text), { mode: 0o600 });
    state.evaluations = []; state.settings.evaluationMaintenance = maintenanceId;
    return { reset: true, database: 'synthetic_database', maintenanceId, backup, sha256: sha(text), archivedCounts: { evaluations: 2 } };
  };
  const launch = async ({ maintenanceId: id }) => { calls.launch++; assert.equal(id, maintenanceId); return { pid: 12345 }; };
  const options = { store, registry, expected, selection, apiDirectory, databaseName: 'synthetic_database', env: {}, reset, launch };
  return { state, calls, options, apiDirectory, expected, reset };
}

test('CLI arguments require exact explicit scope and fixed hashes, rejecting unknown, duplicate or mixed modes', () => {
  assert.deepEqual(parseGemmaRenewalArguments(['--status', '--maintenance-id', maintenanceId]), { mode: 'status', maintenanceId });
  const parsed = parseGemmaRenewalArguments(['--start', ...expectedArgs]);
  assert.equal(parsed.expected.evaluations, 2); assert.equal(parsed.expected.policyVersion, 6);
  assert.deepEqual(parsed.selection, selection);
  for (const args of [[], ['--start'], ['--start', ...expectedArgs, '--start'], ['--status', '--maintenance-id', '../escape'],
    ['--start', ...expectedArgs, '--maintenance-id', maintenanceId], ['--status', '--maintenance-id', maintenanceId, ...expectedArgs],
    ['--start', ...expectedArgs, '--expected-evaluations', '2'], ['--start', ...expectedArgs, '--shell', 'anything'],
    ['--start', ...expectedArgs.slice(0, -1), 'not-a-hash']]) assert.throws(() => parseGemmaRenewalArguments(args), { code: 'INVALID_ARGUMENTS' });
});

test('source and guards precede reset, then verified backup and durable frozen manifest precede detached launch', async t => {
  const { options, calls, apiDirectory, state, reset } = await fixture(t);
  const before = createGemmaBackfillPlan(state, options.registry);
  options.reset = async args => {
    const files = await readdir(path.join(apiDirectory, '.data/backfills'));
    const filename = files.find(name => name.endsWith('.manifest.json'));
    assert.ok(filename, 'Frozen universe must be durable before the destructive subprocess');
    assert.equal(JSON.parse(await readFile(path.join(apiDirectory, '.data/backfills', filename), 'utf8')).conversations[0].sourceHash, before.conversations[0].sourceHash);
    const result = await reset(args); state.conversations[0].messages[0].text = 'Changed after reset'; return result;
  };
  options.launch = async ({ maintenanceId: id, logFile }) => {
    calls.launch++;
    const manifest = JSON.parse(await readFile(path.join(apiDirectory, '.data/backfills', `${id}.json`), 'utf8'));
    const operation = JSON.parse(await readFile(path.join(apiDirectory, '.data/backfills', `${id}.operation.json`), 'utf8'));
    assert.equal(manifest.conversations[0].sourceHash, before.conversations[0].sourceHash);
    assert.equal(operation.status, 'starting'); assert.equal(operation.backupSha256.length, 64);
    assert.equal(operation.codeHashes['src/evaluator.js'].length, 64); assert.equal(operation.logFile, logFile);
    assert.doesNotMatch(JSON.stringify(manifest), /PRIVATE_SYNTHETIC_CONTENT|Changed after reset/);
    return { pid: 12345 };
  };
  const result = await startGemmaRenewal(options);
  assert.equal(result.started, true); assert.equal(result.total, 1); assert.equal(result.dailyEnabled, false);
  assert.equal(calls.reset, 1); assert.equal(calls.launch, 1); assert.equal(calls.ai, 0);
  assert.equal((await stat(result.operationFile)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(result.operationFile)).pid, 12345);
  assert.ok(!(await readdir(path.join(apiDirectory, '.data/backfills'))).includes('renewal-start.lock'));
});

test('changing count, policy, hashes, daily, active jobs, maintenance or real-mode status aborts before reset', async t => {
  const mutations = [
    f => { f.state.evaluations.pop(); }, f => { f.state.settings.aiPolicy.version++; },
    f => { f.expected.configurationHash = '0'.repeat(64); }, f => { f.expected.catalogHash = '0'.repeat(64); },
    f => { f.expected.promptHash = '0'.repeat(64); }, f => { f.state.settings.dailyEnabled = true; },
    f => { f.state.jobs.push({ status: 'queued' }); }, f => { f.state.settings.evaluationMaintenance = maintenanceId; },
    f => { f.state.metadata.demo = true; }, f => { f.state.settings.aiPolicy.mode = 'dual'; },
    f => { f.state.conversations = []; },
    f => { f.state.catalog.forEach(v => { v.active = false; }); },
    f => { f.state.catalog.find(v => v.active).phase = 2; },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t); mutate(f);
    await assert.rejects(startGemmaRenewal(f.options));
    assert.equal(f.calls.reset, 0); assert.equal(f.calls.launch, 0); assert.equal(f.calls.ai, 0);
  }
});

test('Atom failure or reset failure prevents any launch and does not leak raw errors into private journal', async t => {
  const f = await fixture(t);
  f.options.store.readWithConversations = async () => { throw new Error('PRIVATE_SOURCE_ERROR'); };
  await assert.rejects(startGemmaRenewal(f.options)); assert.equal(f.calls.reset, 0); assert.equal(f.calls.launch, 0);
  const g = await fixture(t);
  g.options.reset = async () => { g.calls.reset++; throw new Error('PRIVATE_RESET_ERROR'); };
  await assert.rejects(startGemmaRenewal(g.options)); assert.equal(g.calls.launch, 0);
  const files = await readdir(path.join(g.apiDirectory, '.data/backfills'));
  assert.equal(files.length, 2);
  for (const file of files) assert.doesNotMatch(await readFile(path.join(g.apiDirectory, '.data/backfills', file), 'utf8'), /PRIVATE_/);
});

test('corrupt reset proof and backup checksum block inference after reset', async t => {
  for (const corrupt of [result => { result.sha256 = '0'.repeat(64); }, result => { result.database = 'wrong'; },
    result => { result.archivedCounts.evaluations = 99; }, result => { result.backup = '/outside/private.json'; }]) {
    const f = await fixture(t);
    f.options.reset = async args => { const result = await f.reset(args); corrupt(result); return result; };
    await assert.rejects(startGemmaRenewal(f.options));
    assert.equal(f.calls.reset, 1); assert.equal(f.calls.launch, 0); assert.equal(f.state.settings.evaluationMaintenance, maintenanceId);
  }
});

test('repeat start never cleans a second time; launch failure preserves maintenance and recoverable manifest', async t => {
  const f = await fixture(t);
  f.options.launch = async () => { f.calls.launch++; throw new Error('PRIVATE_LAUNCH_ERROR'); };
  await assert.rejects(startGemmaRenewal(f.options));
  assert.equal(f.calls.reset, 1); assert.equal(f.state.settings.evaluationMaintenance, maintenanceId);
  await assert.rejects(startGemmaRenewal(f.options), { code: 'EVALUATION_MAINTENANCE' });
  assert.equal(f.calls.reset, 1);
  const operation = JSON.parse(await readFile(path.join(f.apiDirectory, '.data/backfills', `${maintenanceId}.operation.json`), 'utf8'));
  assert.equal(operation.status, 'blocked'); assert.equal(operation.error, 'RENEWAL_START_FAILED');
  assert.doesNotMatch(JSON.stringify(operation), /PRIVATE_/);
});

test('status reports checkpoints separately from current task counts and never reads Atom or modifies state', async t => {
  const f = await fixture(t); await startGemmaRenewal(f.options);
  f.state.jobs = [{ id: 'job', maintenanceId, status: 'running' }, { id: 'other', maintenanceId: 'other', status: 'running' }];
  f.state.tasks = [{ jobId: 'job', status: 'completed' }, { jobId: 'job', status: 'partial' }, { jobId: 'other', status: 'completed' }];
  const before = JSON.stringify(f.state), prior = { ...f.calls };
  f.options.store.readWithConversations = async () => assert.fail('Status must not read Atom');
  const status = await gemmaRenewalStatus({ store: f.options.store, apiDirectory: f.apiDirectory, maintenanceId });
  assert.equal(status.readOnly, true); assert.equal(status.runningJobs, 1); assert.equal(status.completedTasks, 1); assert.equal(status.partialTasks, 1);
  assert.equal(status.checkpointCompleted, 0); assert.equal(status.checkpointPending, 1); assert.equal(status.maintenanceActive, true);
  assert.equal(f.calls.launch, prior.launch); assert.equal(f.calls.reset, prior.reset); assert.equal(f.calls.ai, 0);
  assert.equal(JSON.stringify(f.state), before);
});

test('real subprocess plumbing passes fixed reset arguments and detaches only a synthetic worker with a private log', async t => {
  const f = await fixture(t), backupDirectory = path.join(f.apiDirectory, '.data/backups');
  const backup = path.join(backupDirectory, `evaluations-synthetic-${maintenanceId}.json`), text = '{"synthetic":true}';
  const resetArgs = ['--apply', '--expected-evaluations', '2', '--expected-policy-version', '6',
    '--expected-configuration-hash', f.expected.configurationHash, '--expected-catalog-hash', f.expected.catalogHash,
    '--expected-prompt-hash', f.expected.promptHash];
  await writeFile(path.join(f.apiDirectory, 'scripts/reset-evaluations.js'), `
    const fs = require('node:fs/promises');
    (async () => {
      if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(resetArgs))}) throw Error('Wrong reset arguments');
      await fs.mkdir(${JSON.stringify(backupDirectory)}, {recursive:true});
      await fs.writeFile(${JSON.stringify(backup)}, ${JSON.stringify(text)}, {mode:0o600});
      await fs.writeFile(${JSON.stringify(`${backup}.sha256`)}, ${JSON.stringify(sha(text))}, {mode:0o600});
      process.stdout.write(${JSON.stringify(JSON.stringify({reset:true,database:'synthetic_database',maintenanceId,backup,sha256:sha(text),archivedCounts:{evaluations:2}}))});
    })().catch(() => { process.exitCode=1; });
  `);
  await writeFile(path.join(f.apiDirectory, 'scripts/evaluate-all.js'), `
    const fs = require('node:fs');
    if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(['--execute','--maintenance-id',maintenanceId]))}) throw Error('Wrong worker arguments');
    const manifest=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.apiDirectory, '.data/backfills', `${maintenanceId}.json`))},'utf8'));
    if(manifest.id!==${JSON.stringify(maintenanceId)}) throw Error('Manifest was not ready');
    process.stdout.write('synthetic-worker-started');
  `);
  delete f.options.reset; delete f.options.launch;
  const result = await startGemmaRenewal(f.options);
  assert.equal(result.started, true); assert.ok(result.pid > 0);
  let log = '';
  for (let index = 0; index < 100 && !log; index++) {
    log = await readFile(result.logFile, 'utf8');
    if (!log) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(log, 'synthetic-worker-started'); assert.equal((await stat(result.logFile)).mode & 0o777, 0o600);
  assert.equal(f.calls.ai, 0);
});

test('help and invalid CLI arguments do not load server configuration or start an operation', () => {
  const script = new URL('../scripts/start-gemma-renewal.js', import.meta.url).pathname;
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /Estado de solo lectura/);
  const invalid = spawnSync(process.execPath, [script, '--url', 'PRIVATE_UNTRUSTED_URL'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.doesNotMatch(invalid.stderr, /PRIVATE_/); assert.equal(invalid.stdout, '');
});
