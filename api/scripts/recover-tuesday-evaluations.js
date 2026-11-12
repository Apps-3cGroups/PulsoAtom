import { readFile, mkdir, cp, symlink, open } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECOVERY_ID, RECOVERY_JOBS, recoveryPlan, prepareRecovery, verifyPreservedResults } from '../src/gemma-incident-recovery.js';
import { resumeEvaluationBatch, evaluationModelProgress } from '../src/evaluation-service.js';
import { sourceFingerprint } from '../src/evaluation-context.js';
import { acquireBackfillLock, persistBackfillManifest } from '../src/gemma-backfill.js';

const productionApi = '/var/www/nodeapps/PulsoAtom/api';
const directory = `${productionApi}/.data/incident-recovery/${RECOVERY_ID}`;
const manifestFile = `${directory}/manifest.json`;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = e => /^[A-Z_]{3,80}$/.test(e?.code || '') ? e.code : 'RECOVERY_FAILED';
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const readManifest = async () => JSON.parse(await readFile(manifestFile, 'utf8'));
function assertManifest(m) { if (m?.id !== RECOVERY_ID || m.plan?.id !== RECOVERY_ID || !Array.isArray(m.plan.completed)) fail('INVALID_MANIFEST'); }
function assertStable(state, manifest) {
  assertManifest(manifest);
  if (state.settings.evaluationMaintenance !== RECOVERY_ID) fail('MAINTENANCE_CHANGED');
  if (state.jobs.some(j => j.status === 'running' && !RECOVERY_JOBS.includes(j.id))) fail('OTHER_JOB_RUNNING');
  verifyPreservedResults(state, manifest.plan);
}
function status(state, manifest) {
  assertManifest(manifest);
  const tasks = state.tasks.filter(t => RECOVERY_JOBS.includes(t.jobId) && t.status !== 'deferred');
  return { id: RECOVERY_ID, date: manifest.plan.activityDate, status: manifest.status,
    workerAlive: alive(manifest.pid), startedAt: manifest.startedAt || null, updatedAt: manifest.updatedAt || null,
    completedResultsPreserved: verifyPreservedResults(state, manifest.plan),
    maintenanceActive: state.settings.evaluationMaintenance === RECOVERY_ID,
    totalTasks: tasks.length, completed: tasks.filter(t => t.status === 'completed').length,
    remaining: tasks.filter(t => t.status !== 'completed').length,
    errors: tasks.filter(t => t.status !== 'completed').reduce((o,t) => { const code = t.error?.code || t.status; o[code] = (o[code] || 0) + 1; return o; }, {}),
    jobs: RECOVERY_JOBS.map(id => { const job = state.jobs.find(j => j.id === id); return { id, status: job?.status, progress: evaluationModelProgress(state, job) }; }),
    errorCode: manifest.errorCode || null, sourceChanged: manifest.sourceChanged || [] };
}
async function start(store) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquireBackfillLock(`${directory}/launch.lock`, RECOVERY_ID);
  try {
    let existing; try { existing = await readManifest(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing) return { alreadyStarted: true, ...status(await store.read(), existing) };
    // Workflow stops precisely this process before preparing in-flight tasks.
    const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PM2_HOME: '/home/td/.pm2' } }));
    const api = processes.filter(p => p.name === 'pulso-atom-api');
    if (api.length !== 1 || api[0].pm2_env.status !== 'stopped') fail('API_MUST_BE_STOPPED');
    const state = await store.read(), plan = recoveryPlan(state);
    const manifest = { id: RECOVERY_ID, status: 'prepared', plan, createdAt: new Date().toISOString() };
    // Private backup, never printed or uploaded. Preserve the exact incident
    // tasks, attempts, results and configuration before any state mutation.
    await persistBackfillManifest(`${directory}/backup.json`, {
      settings: state.settings, jobs: state.jobs.filter(j => RECOVERY_JOBS.includes(j.id)),
      tasks: state.tasks.filter(t => RECOVERY_JOBS.includes(t.jobId)), attempts: state.attempts.filter(a => RECOVERY_JOBS.includes(a.jobId)),
      evaluations: state.evaluations.filter(e => RECOVERY_JOBS.includes(e.jobId)),
    });
    const source = fileURLToPath(new URL('../', import.meta.url)), workerApi = `${directory}/worker-api`;
    await mkdir(workerApi, { mode: 0o700 });
    for (const entry of ['src', 'scripts', 'package.json']) await cp(path.join(source, entry), path.join(workerApi, entry),
      { recursive: true, errorOnExist: true, force: false, filter: f => !['.env', '.data', 'node_modules'].includes(path.basename(f)) });
    await symlink(`${productionApi}/node_modules`, `${workerApi}/node_modules`);
    await store.transaction(draft => prepareRecovery(draft, plan, new Date().toISOString()));
    await persistBackfillManifest(manifestFile, manifest);
    const log = await open(`${directory}/worker.log`, 'wx', 0o600);
    try {
      const child = spawn(process.execPath, [`--env-file=${productionApi}/.env`, `${workerApi}/scripts/recover-tuesday-evaluations.js`, '--worker'],
        { cwd: workerApi, env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
      return { started: true, id: RECOVERY_ID, pendingTasks: plan.pending.length, preservedCompletedTasks: plan.completed.length, pid: child.pid };
    } finally { await log.close(); }
  } finally { await release(); }
}
async function worker(store, registry) {
  const release = await acquireBackfillLock(`${directory}/worker.lock`, RECOVERY_ID);
  let manifest;
  try {
    manifest = await readManifest(); assertManifest(manifest);
    if (manifest.status !== 'prepared') fail('WORKER_ALREADY_STARTED');
    Object.assign(manifest, { status: 'running', pid: process.pid, startedAt: new Date().toISOString() });
    await persistBackfillManifest(manifestFile, manifest);
    const guarded = { read: () => store.read(), readWithConversations: options => store.readWithConversations(options),
      transaction: fn => store.transaction(s => { assertStable(s, manifest); return fn(s); }) };
    // Three bounded recovery rounds. Each reuses valid profile answers and
    // invokes only missing variables; successful tasks are never selected.
    for (let round = 1; round <= 3; round++) {
      for (const jobId of RECOVERY_JOBS) {
        const snapshot = await store.read(); assertStable(snapshot, manifest);
        const pending = snapshot.tasks.filter(t => t.jobId === jobId && !['completed', 'deferred'].includes(t.status));
        if (!pending.length) continue;
        const ids = [...new Set(pending.map(t => t.conversationId))];
        const fresh = await store.readWithConversations({ fresh: true, conversationIds: ids });
        const stableIds = ids.filter(id => { const c = fresh.conversations.find(c => c.id === id);
          return c && pending.filter(t => t.conversationId === id).every(t => t.context.sourceHash === sourceFingerprint(c)); });
        manifest.sourceChanged = [...new Set([...(manifest.sourceChanged || []), ...ids.filter(id => !stableIds.includes(id))])];
        Object.assign(manifest, { round, currentJob: jobId, updatedAt: new Date().toISOString() });
        await persistBackfillManifest(manifestFile, manifest);
        if (stableIds.length) await (await resumeEvaluationBatch(guarded, registry, jobId, { conversationIds: stableIds })).completion;
      }
      const current = await store.read(); assertStable(current, manifest);
      const remaining = current.tasks.filter(t => RECOVERY_JOBS.includes(t.jobId) && !['completed', 'deferred'].includes(t.status));
      if (!remaining.length) break;
      if (remaining.some(t => ['MODEL_CHANGED', 'MODEL_IDENTITY_UNVERIFIED', 'AI_CONFIGURATION'].includes(t.error?.code))) fail('PROVIDER_REQUIRES_INTERVENTION');
    }
    const final = status(await store.read(), manifest);
    Object.assign(manifest, { status: final.remaining ? 'partial' : 'completed', updatedAt: new Date().toISOString() });
    if (!final.remaining) await store.transaction(s => {
      assertStable(s, manifest);
      if (s.tasks.some(t => RECOVERY_JOBS.includes(t.jobId) && !['completed', 'deferred'].includes(t.status))) fail('RECOVERY_STATE_CHANGED');
      s.settings.evaluationMaintenance = manifest.plan.priorMaintenance;
      Object.assign(s.settings.gemmaIncidentRecovery, { status: 'completed', completedAt: manifest.updatedAt });
    });
    await persistBackfillManifest(manifestFile, manifest);
    console.log(JSON.stringify(status(await store.read(), manifest)));
  } catch (e) {
    if (manifest) { Object.assign(manifest, { status: 'blocked', errorCode: safeCode(e), updatedAt: new Date().toISOString() }); await persistBackfillManifest(manifestFile, manifest); }
    throw e;
  } finally { await release(); }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--start', '--worker', '--status'].includes(args[0])) fail('INVALID_ARGUMENTS');
  const { config, databaseConfig, atomDatabaseConfig } = await import('../src/config.js');
  const { MysqlStore, AtomHistoryStore } = await import('../src/store.js');
  const { AtomReader } = await import('../src/atom.js');
  const { registryFromEnv } = await import('../src/model-registry.js');
  const db = databaseConfig(); if (config.demo || db?.database !== 'dbPulsosAtom') fail('REAL_MODE_REQUIRED');
  const store = args[0] === '--worker' ? new AtomHistoryStore(new MysqlStore(db), new AtomReader(atomDatabaseConfig(), config.timezone)) : new MysqlStore(db);
  try {
    const result = args[0] === '--start' ? await start(store) : args[0] === '--worker' ? await worker(store, registryFromEnv()) : status(await store.read(), await readManifest());
    if (result) console.log(JSON.stringify(result, null, 2));
  } finally { await store.close(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, errorCode: safeCode(e) })); process.exitCode = 1; });
