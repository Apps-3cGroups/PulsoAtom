import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { changeDeploymentLease, waitForDeploymentLease, isEvaluationWorker, assertSafeWorkingTree, verifyLocalHealth, inspectWorkers } from '../scripts/deployment-lease.mjs';

const request = { operation: 'claim', id: 'deployment:12345678-1234-1234-1234-123456789012', revision: 'a'.repeat(40), owner: 'github:123:1' };
const dependencies = { workers: async () => 0, health: async () => {}, now: () => '2026-11-13T12:00:00.000Z' };
function database({ maintenance = null, jobs = [], tasks = [], attempts = [] } = {}) {
  const state = { settings: { version: 21, evaluationMaintenance: maintenance, appearance: { scale: 1.5 },
    thursdayHandoff: { status: 'caught_up' }, tuesdayWednesdayCompletion: { status: 'waiting_thursday' } }, jobs, tasks, attempts };
  const log = []; let queue = Promise.resolve(); let locked = false;
  const pool = { async getConnection() {
    let releaseLock, next, draft;
    return {
      async beginTransaction() { log.push('begin'); },
      async query(sql) {
        log.push(sql);
        if (sql === 'SELECT id FROM app_lock WHERE id = 1 FOR UPDATE') {
          const previous = queue; queue = new Promise(resolve => { next = resolve; });
          await previous; locked = true; releaseLock = () => { locked = false; next(); };
          draft = structuredClone(state); return [[{ id: 1 }]];
        }
        assert.equal(locked, true, 'status must be read under app_lock');
        const key = sql.includes('evaluation_jobs') ? 'jobs' : sql.includes('evaluation_tasks') ? 'tasks' : 'attempts';
        const statuses = key === 'jobs' ? ['running', 'pending', 'queued'] : ['running'];
        return [[{ running: draft[key].filter(row => statuses.includes(row.status)).length }]];
      },
      async execute(sql, args) {
        assert.equal(locked, true); log.push(sql);
        if (sql.startsWith('SELECT payload')) return [[{ payload: JSON.stringify(draft.settings) }]];
        assert.equal(sql, "UPDATE portal_settings SET payload = ? WHERE id = 'settings'");
        draft.settings = JSON.parse(args[0]); return [{ affectedRows: 1 }];
      },
      async commit() { log.push('commit'); state.settings = draft.settings; releaseLock?.(); releaseLock = null; },
      async rollback() { log.push('rollback'); releaseLock?.(); releaseLock = null; },
      release() { assert.equal(releaseLock, null); log.push('release'); },
    };
  } };
  return { state, pool, log, isLocked: () => locked };
}
test('claim uses the application lock and changes only its own settings marker', async () => {
  const db = database({ jobs: [{ status: 'interrupted' }], tasks: [{ status: 'pending' }], attempts: [{ status: 'failed' }, { status: 'interrupted' }] });
  const before = structuredClone(db.state);
  const result = await changeDeploymentLease(db.pool, request, dependencies);
  assert.equal(result.status, 'active'); assert.equal(db.state.settings.evaluationMaintenance, request.id);
  assert.equal(db.state.settings.version, 21); assert.deepEqual(db.state.jobs, before.jobs);
  assert.deepEqual(db.state.tasks, before.tasks); assert.deepEqual(db.state.attempts, before.attempts);
  assert.deepEqual(db.state.settings.appearance, before.settings.appearance);
  assert.deepEqual(db.state.settings.thursdayHandoff, before.settings.thursdayHandoff);
  assert.deepEqual(db.state.settings.tuesdayWednesdayCompletion, before.settings.tuesdayWednesdayCompletion);
  assert.equal(db.log.filter(sql => sql.startsWith('UPDATE')).length, 1);
  assert.ok(db.log.indexOf('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE') < db.log.indexOf("SELECT payload FROM portal_settings WHERE id = 'settings'"));
});
test('foreign maintenance, including RECOVERY_ID, cannot be stolen', async () => {
  for (const maintenance of ['recovery-owner', request.id]) {
    const db = database({ maintenance }); const before = structuredClone(db.state);
    await assert.rejects(changeDeploymentLease(db.pool, request, dependencies), { code: 'DEPLOYMENT_OTHER_MAINTENANCE' });
    assert.deepEqual(db.state, before); assert.ok(!db.log.some(sql => sql.startsWith('UPDATE')));
  }
});
test('jobs running/pending/queued and tasks or attempts running prevent claim', async () => {
  for (const state of [{ jobs: [{ status: 'running' }] }, { jobs: [{ status: 'pending' }] }, { jobs: [{ status: 'queued' }] },
    { tasks: [{ status: 'running' }] }, { attempts: [{ status: 'running' }] }]) {
    const db = database(state); const before = structuredClone(db.state);
    await assert.rejects(changeDeploymentLease(db.pool, request, dependencies), { code: 'DEPLOYMENT_EVALUATION_RUNNING' });
    assert.deepEqual(db.state, before);
  }
});
test('live or uncertain detached process prevents claim without signaling or recovering it', async () => {
  for (const workers of [async () => 1, async () => { throw Object.assign(Error('unknown'), { code: 'DEPLOYMENT_PROCESS_CHECK_UNAVAILABLE' }); }]) {
    const db = database(); const before = structuredClone(db.state);
    await assert.rejects(changeDeploymentLease(db.pool, request, { ...dependencies, workers }));
    assert.deepEqual(db.state, before);
  }
});
test('two concurrent claimants cannot both acquire maintenance', async () => {
  const db = database();
  const results = await Promise.allSettled([changeDeploymentLease(db.pool, request, dependencies),
    changeDeploymentLease(db.pool, { ...request, id: 'deployment:87654321-1234-1234-1234-123456789012' }, dependencies)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'DEPLOYMENT_OTHER_MAINTENANCE');
});
test('release requires health and exact lease identity, then restores null without changing recovery', async () => {
  const db = database(); await changeDeploymentLease(db.pool, request, dependencies);
  const active = structuredClone(db.state);
  await assert.rejects(changeDeploymentLease(db.pool, { ...request, operation: 'release' }, { ...dependencies, health: async () => { throw Object.assign(Error(), { code: 'DEPLOYMENT_HEALTH_FAILED' }); } }), { code: 'DEPLOYMENT_HEALTH_FAILED' });
  assert.deepEqual(db.state, active);
  for (const change of [{ owner: 'github:123:2' }, { revision: 'b'.repeat(40) }, { id: 'deployment:87654321-1234-1234-1234-123456789012' }]) {
    await assert.rejects(changeDeploymentLease(db.pool, { ...request, ...change, operation: 'release' }, dependencies), { code: 'DEPLOYMENT_LEASE_CHANGED' });
    assert.deepEqual(db.state, active);
  }
  await changeDeploymentLease(db.pool, { ...request, operation: 'release' }, dependencies);
  assert.equal(db.state.settings.evaluationMaintenance, null); assert.equal(db.state.settings.deploymentLease.status, 'released');
  assert.equal(db.state.settings.version, 21); assert.deepEqual(db.state.settings.tuesdayWednesdayCompletion, active.settings.tuesdayWednesdayCompletion);
});
test('bounded idle wait releases the transaction between retries and acquires only after completion', async () => {
  const db = database({ jobs: [{ status: 'running' }] }); let time = 0, sleeps = 0;
  await waitForDeploymentLease(db.pool, request, { ...dependencies, waitSeconds: 90, clock: () => time, sleep: async ms => {
    assert.equal(db.isLocked(), false); assert.equal(db.state.settings.evaluationMaintenance, null);
    assert.equal(ms, 30000); time += ms; if (++sleeps === 2) db.state.jobs[0].status = 'completed';
  } });
  assert.equal(sleeps, 2); assert.equal(db.state.settings.evaluationMaintenance, request.id);
  assert.equal(db.log.filter(sql => sql.startsWith('UPDATE')).length, 1);
});
test('idle wait times out read-only, and does not wait through foreign locks or uncertain workers', async () => {
  const busy = database({ jobs: [{ status: 'running' }] }); let time = 0;
  await assert.rejects(waitForDeploymentLease(busy.pool, request, { ...dependencies, waitSeconds: 45, clock: () => time, sleep: async ms => { time += ms; } }), { code: 'DEPLOYMENT_EVALUATION_RUNNING' });
  assert.equal(time, 45000); assert.equal(busy.state.settings.evaluationMaintenance, null);
  for (const [db, workers] of [[database({ maintenance: 'other' }), async () => 0], [database(), async () => 1]]) {
    await assert.rejects(waitForDeploymentLease(db.pool, request, { ...dependencies, workers, waitSeconds: 45, sleep: async () => assert.fail('Must not wait') }));
  }
});
test('worker detection includes copied workers and relative launch scripts, excluding read-only commands', () => {
  const api = '/var/www/nodeapps/PulsoAtom/api';
  assert.equal(isEvaluationWorker(['node', `${api}/.data/recovery/worker-api/scripts/complete-tuesday-wednesday.js`, '--worker']), true);
  assert.equal(isEvaluationWorker(['node', 'scripts/evaluate-all.js', '--execute'], api), true);
  assert.equal(isEvaluationWorker(['node', `${api}/scripts/complete-tuesday-wednesday.js`, '--resume-tuesday']), true);
  assert.equal(isEvaluationWorker(['node', `${api}/scripts/complete-tuesday-wednesday.js`, '--status']), false);
  assert.equal(isEvaluationWorker(['node', `${api}/server.js`], api), false);
  assert.equal(isEvaluationWorker(['node', '/other/scripts/evaluate-all.js', '--execute'], '/other'), false);
});
test('health check requires successful API and portal responses', async () => {
  const urls = []; await verifyLocalHealth(async url => { urls.push(url); return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; });
  assert.equal(urls.length, 2);
  await assert.rejects(verifyLocalHealth(async () => ({ ok: false })), { code: 'DEPLOYMENT_HEALTH_FAILED' });
});
test('working tree guard rejects every unknown untracked or tracked change', async () => {
  assert.deepEqual(await assertSafeWorkingTree('/unused', () => ''), { clean: true, preservedStaticBackup: false });
  for (const changes of ['?? api/unexpected.json\0', ' M api/src/app.js\0', '?? web/.static-backups/foreign/index.html\0']) {
    await assert.rejects(assertSafeWorkingTree('/unused', () => changes), { code: 'DEPLOYMENT_WORKTREE_CHANGED' });
  }
});
test('workflow leases before checkout/dependencies/restart, releases only after health, and retains lease on failure', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/deploy-pulso-atom.yml', import.meta.url), 'utf8');
  const script = workflow.match(/\$remoteScript = @'\n([\s\S]*?)\n {10}'@/)?.[1];
  assert.ok(script);
  const claim = script.indexOf('--claim --id');
  assert.ok(claim > script.indexOf('git fetch origin main'));
  assert.ok(claim > script.indexOf('"$(git rev-parse FETCH_HEAD)" = "$TARGET_SHA"'));
  assert.ok(claim < script.indexOf('git merge --ff-only'));
  assert.ok(claim < script.indexOf('npm ci --prefix "$API"'));
  assert.ok(claim < script.indexOf('pm2 startOrReload'));
  const release = script.indexOf('--release --id');
  assert.ok(release > script.indexOf('Checking PulsoAtom health and web'));
  assert.match(script, /--wait-idle-seconds 2700/);
  const cleanup = script.match(/cleanup\(\) \{([\s\S]*?)\n {10}\}/)?.[1];
  assert.match(cleanup, /Deployment maintenance retained/); assert.doesNotMatch(cleanup, /--release/);
  assert.match(workflow, /timeout-minutes: 60/);
  assert.match(script, /--check-working-tree/);
  assert.doesNotMatch(script, /git pull/);
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pulso-deploy-shell-')));
  try {
    const file = path.join(directory, 'deploy.sh'); await writeFile(file, script.replace(/^ {10}/gm, ''));
    execFileSync('bash', ['-n', file]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only the exact authorized private static backup is preserved through preflight', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pulso-backup-guard-')));
  const relative = 'web/.static-backups/0426e95a-da13-4825-87ef-e8fc2025017c';
  const directory = path.join(root, relative);
  const status = () => `?? ${relative}/index.html\0?? ${relative}/artifact.json\0`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'index.html'), "<!doctype html>\n<html lang=\"es\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    <meta name=\"theme-color\" content=\"#0d1411\" />\n    <meta name=\"description\" content=\"Pulso · Revisión histórica de conversaciones y calidad de atención.\" />\n    <title>Pulso · Conversaciones que importan</title>\n    <script type=\"module\" crossorigin src=\"/pulsoAtom/assets/index-DcV7FDEH.js\"></script>\n    <link rel=\"stylesheet\" crossorigin href=\"/pulsoAtom/assets/index-CdSHbCC8.css\">\n  </head>\n  <body>\n    <div id=\"root\"></div>\n  </body>\n</html>\n");
    await writeFile(path.join(directory, 'artifact.json'), JSON.stringify({ format: 'pulso-web-static-v1', basePath: '/pulsoAtom',
      expectedIndexSha256: 'ff72c7f916564bc1c3ba122bd3413bdecedaa309f956398410f8873dbf95c299',
      files: [{ path: 'index.html', sha256: '7f30cda99c486651bfdc3d56b627e1f0a0823e2e37f8b7ae7e13b00f3ccd8280' }] }));
    assert.deepEqual(await assertSafeWorkingTree(root, status), { clean: true, preservedStaticBackup: true });
    await writeFile(path.join(directory, 'index.html'), 'wrong backup');
    await assert.rejects(assertSafeWorkingTree(root, status), { code: 'UNEXPECTED_STATIC_BACKUP' });
    await writeFile(path.join(directory, 'index.html'), "<!doctype html>\n<html lang=\"es\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    <meta name=\"theme-color\" content=\"#0d1411\" />\n    <meta name=\"description\" content=\"Pulso · Revisión histórica de conversaciones y calidad de atención.\" />\n    <title>Pulso · Conversaciones que importan</title>\n    <script type=\"module\" crossorigin src=\"/pulsoAtom/assets/index-DcV7FDEH.js\"></script>\n    <link rel=\"stylesheet\" crossorigin href=\"/pulsoAtom/assets/index-CdSHbCC8.css\">\n  </head>\n  <body>\n    <div id=\"root\"></div>\n  </body>\n</html>\n");
    await writeFile(path.join(directory, 'extra'), 'unexpected');
    await assert.rejects(assertSafeWorkingTree(root, status), { code: 'UNEXPECTED_STATIC_BACKUP' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('process inspection detects live copied workers, excluding zombies and disappeared processes', async () => {
  const proc = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pulso-proc-guard-')));
  try {
    for (const [pid, status] of [[123, 'S'], [124, 'Z'], [125, 'S']]) {
      const dir = path.join(proc, String(pid)); await mkdir(dir);
      await writeFile(path.join(dir, 'stat'), `${pid} (node) ${status} 1 2 3`);
      if (pid !== 125) {
        await writeFile(path.join(dir, 'cmdline'), 'node\0/var/www/nodeapps/PulsoAtom/api/.data/worker-api/scripts/complete-tuesday-wednesday.js\0--worker\0');
        await symlink('/var/www/nodeapps/PulsoAtom/api', path.join(dir, 'cwd'));
      }
    }
    assert.equal(await inspectWorkers({ proc, uid: process.getuid(), ownPid: 0 }), 1);
  } finally { await rm(proc, { recursive: true, force: true }); }
});
