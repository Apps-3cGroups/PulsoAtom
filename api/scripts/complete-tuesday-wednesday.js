import { readFile, mkdir, cp, symlink, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { digest } from '../src/evaluation-context.js';
import { RECOVERY_ID, RECOVERY_JOBS } from '../src/gemma-incident-recovery.js';
import { acquireBackfillLock, persistBackfillManifest } from '../src/gemma-backfill.js';
import { startEvaluationBatch, resumeEvaluationBatch } from '../src/evaluation-service.js';
import { COMPLETION_ID, COMPLETION_KEYS, COMPLETION_MODELS, makeCompletionPlan, selectCompletionSources,
  assertOriginalIncident, assertCompletionPlan, assertCompletionStable, assertCompletionSource, completionSources, completionRetry, completionExclusions, COMPLETION_EXCLUSION_REASON,
  prepareCompletion, setCompletionConcurrency, completionStatus, completionTasks, assertPhaseJob, finishCompletion, finalizedCompletion,
  prepareThursdayPriority, deferTuesdayForThursday, assertDeferredThursday, claimDeferredTuesday, completionFailure as fail } from '../src/tuesday-wednesday-completion.js';

const productionApi = '/var/www/nodeapps/PulsoAtom/api';
const incidentDirectory = `${productionApi}/.data/incident-recovery/${RECOVERY_ID}`;
const incidentFile = `${incidentDirectory}/manifest.json`;
const directory = `${productionApi}/.data/incident-completion/${COMPLETION_ID}`;
const manifestFile = `${directory}/manifest.json`;
const workerApi = `${directory}/worker-api`;
const workerScript = `${workerApi}/scripts/complete-tuesday-wednesday.js`;
const oldWorkerScript = `${incidentDirectory}/worker-api/scripts/recover-tuesday-evaluations.js`;
const safeCode = error => typeof error?.code === 'string' && /^[A-Z_]{3,80}(?![\s\S])/.test(error.code) ? error.code : 'COMPLETION_FAILED';
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function readManifest() { const m = await readJson(manifestFile); assertCompletionPlan(m.plan); if (m.id !== COMPLETION_ID) fail('INVALID_COMPLETION_MANIFEST'); return m; }
async function optionalManifest() { try { return await readManifest(); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

export async function processState(pid, expectedScript, { read = readFile, kill = process.kill } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { alive: false };
  try { kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return { alive: false }; throw e; }
  try {
    const stat = await read(`/proc/${pid}/stat`, 'utf8');
    if (/\) Z /.test(stat)) return { alive: false };
    const args = (await read(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    if (!args.includes(expectedScript) || !args.includes('--worker')) fail('WORKER_IDENTITY_CHANGED');
    return { alive: true };
  } catch (e) { if (['ENOENT', 'ESRCH'].includes(e.code)) return { alive: false }; throw e; }
}
export async function stopOwnedWorker(manifest, { inspect = processState, signal = process.kill,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), maxWaitMs = 8000 } = {}) {
  if (manifest?.id !== COMPLETION_ID) fail('INVALID_COMPLETION_MANIFEST');
  if (!(await inspect(manifest.pid, workerScript)).alive) return { stopped: false, alreadyStopped: true, workerAlive: false };
  // No PID is accepted from the CLI. The private manifest and exact script /
  // --worker identity must agree before sending this one graceful signal.
  try { signal(manifest.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (let waited = 0; waited <= maxWaitMs; waited += 100) {
    try {
      if (!(await inspect(manifest.pid, workerScript)).alive) return { stopped: true, workerAlive: false };
    } catch (error) {
      // Linux can expose an empty cmdline while a signaled process exits.
      // This is uncertainty, never proof of death: keep waiting for ESRCH or
      // a zombie, send no more signals, and time out if identity stays unknown.
      if (error.code !== 'WORKER_IDENTITY_CHANGED') throw error;
    }
    if (waited < maxWaitMs) await pause(100);
  }
  // A still-live or changed process is never escalated to SIGKILL, and its
  // manifest/locks remain untouched so a subsequent start cannot replace it.
  fail('WORKER_STOP_TIMEOUT');
}
async function stop() {
  const release = await acquireBackfillLock(`${incidentDirectory}/launch.lock`, COMPLETION_ID);
  try {
    const manifest = await optionalManifest();
    if (!manifest) return { id: COMPLETION_ID, status: 'not_started', workerAlive: false };
    const result = await stopOwnedWorker(manifest);
    const latest = await readManifest();
    if (latest.pid !== manifest.pid) fail('WORKER_ASSIGNMENT_CHANGED');
    if (!['completed', 'waiting_thursday'].includes(latest.status)) {
      Object.assign(latest, { status: 'stopped', stoppedAt: new Date().toISOString(), stopReason: 'APPLY_VERIFIED_WORKER_FIX' });
      await persistBackfillManifest(manifestFile, latest);
    }
    return { id: COMPLETION_ID, status: latest.status, workerPid: latest.pid, ...result };
  } finally { await release(); }
}
async function verifyNoWorker(incident, manifest) {
  if ((await processState(incident.pid, oldWorkerScript)).alive) fail('INCIDENT_WORKER_RUNNING');
  if (manifest && (await processState(manifest.pid, workerScript)).alive) return false;
  // Stale locks are removed only under the shared launch lock, after checking
  // their host, owner and exact dead PID against a private manifest.
  const file = `${incidentDirectory}/worker.lock`;
  let raw; try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
  const lock = JSON.parse(raw);
  const own = lock.maintenanceId === COMPLETION_ID && lock.pid === manifest?.pid;
  const old = lock.maintenanceId === RECOVERY_ID && lock.pid === incident.pid;
  if (lock.hostname !== os.hostname() || (!own && !old)) fail('WORKER_LOCK_CHANGED');
  if ((await processState(lock.pid, own ? workerScript : oldWorkerScript)).alive) fail('WORKER_STILL_RUNNING');
  if (await readFile(file, 'utf8') !== raw) fail('WORKER_LOCK_CHANGED');
  await unlink(file); return true;
}

async function freshPlan(store, registry, incident) {
  const state = await store.base.read();
  assertOriginalIncident(state, incident, (await processState(incident.pid, oldWorkerScript)).alive);
  const metadata = await store.reader.readOverview({ from: '2026-11-10', to: '2026-11-12', dateBasis: 'activity', countries: ['HN', 'PA'] }, { metadataOnly: true });
  const candidates = selectCompletionSources({ ...state, conversations: metadata.conversations });
  const ids = [...candidates.retry.map(t => t.conversationId), ...candidates.tuesday.map(c => c.id), ...candidates.wednesday.map(c => c.id)];
  const source = await store.reader.read({ fresh: true, conversationIds: ids });
  return { state: store.attach(state, source), plan: makeCompletionPlan(store.attach(state, source), registry, incident) };
}

async function inspect(store, registry) {
  const existing = await optionalManifest();
  if (existing) {
    const state = await store.read(), manifest = deferredThursdayManifest(state, registry, existing) || existing;
    return { readOnly: true, ...completionStatus(state, existing.plan, manifest, (await processState(existing.pid, workerScript)).alive) };
  }
  const incident = await readJson(incidentFile), { state, plan } = await freshPlan(store, registry, incident);
  return { readOnly: true, ready: true, ...completionStatus(state, plan),
    scope: { retryConversations: 2, excludedConversations: 1, newTuesdayHN: 167, newWednesday: { HN: 20, PA: 23 } }, concurrency: 1 };
}
async function copyWorker() {
  const source = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(workerApi, { recursive: true, mode: 0o700 });
  for (const entry of ['src', 'scripts', 'package.json']) await cp(path.join(source, entry), path.join(workerApi, entry), {
    recursive: true, force: true, filter: file => !['.env', '.data', 'node_modules'].includes(path.basename(file)) });
  try { await symlink(`${productionApi}/node_modules`, `${workerApi}/node_modules`); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}
export async function persistPrivateBackup(file, snapshot) {
  let existing;
  try { existing = await readJson(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    const content = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'createdAt'));
    if (digest(content(existing)) !== digest(content(snapshot))) fail('BACKUP_CHANGED');
    return;
  }
  // Atomic private-file replacement avoids a half-written orphan if the launcher
  // dies before saving the manifest. The shared launch lock serializes callers.
  await persistBackfillManifest(file, snapshot);
}
async function privateBackup(state, plan) {
  const ids = new Set(completionSources(plan).map(c => c.id)), jobs = new Set(RECOVERY_JOBS);
  const scope = Object.fromEntries(Object.entries(plan).filter(([key]) => !['createdAt', 'integrityHash'].includes(key)));
  await persistPrivateBackup(`${directory}/backup.json`, { id: COMPLETION_ID, scopeHash: digest(scope), createdAt: plan.createdAt, settings: state.settings,
    jobs: state.jobs.filter(j => jobs.has(j.id)), tasks: state.tasks.filter(t => jobs.has(t.jobId)),
    attempts: state.attempts.filter(a => jobs.has(a.jobId)), evaluations: state.evaluations.filter(e => jobs.has(e.jobId) || ids.has(e.conversationId)),
    operationalRefs: state.operationalRefs.filter(r => ids.has(r.id)) });
}
export async function recordSpawnedWorker(manifest, child, persist = persistBackfillManifest, file = manifestFile) {
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) fail('INVALID_WORKER_PID');
  manifest.pid = child.pid;
  await persist(file, manifest);
  child.unref();
  return child.pid;
}
export async function waitForWorkerAssignment(pid, { read = readManifest, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const manifest = await read();
    if (manifest.pid === pid && manifest.status === 'prepared') return manifest;
    if (manifest.pid != null && manifest.pid !== pid || manifest.status !== 'prepared') fail('WORKER_ASSIGNMENT_CHANGED');
    await pause(100);
  }
  fail('WORKER_ASSIGNMENT_TIMEOUT');
}
// The database checkpoint is authoritative if the subsequent manifest write
// failed. Read-only status/inspect use this projection without writing files.
export function deferredThursdayManifest(state, registry, manifest) {
  if (state.settings.tuesdayWednesdayCompletion?.status !== 'waiting_thursday') return null;
  const at = assertDeferredThursday(state, registry, manifest.plan);
  return { ...manifest, status: 'waiting_thursday', phase: 'waiting_thursday', updatedAt: at,
    waitingThursdayAt: at, finishedAt: null, errorCode: null };
}

export async function configureThursdayPriority(store, registry, manifest, options, { inspectWorker = processState } = {}) {
  assertCompletionPlan(manifest.plan);
  if (manifest.id !== COMPLETION_ID) fail('INVALID_COMPLETION_MANIFEST');
  // Frozen workers from a prior release do not know this checkpoint. Require a
  // stopped process so the following start copies the newly deployed code.
  if ((await inspectWorker(manifest.pid, workerScript)).alive) fail('COMPLETION_WORKER_RUNNING');
  return store.transaction(state => prepareThursdayPriority(state, registry, manifest.plan, options));
}

async function prioritizeThursday(store, registry, options) {
  const release = await acquireBackfillLock(`${incidentDirectory}/launch.lock`, COMPLETION_ID);
  try {
    const manifest = await readManifest(), incident = await readJson(incidentFile);
    if (!await verifyNoWorker(incident, manifest)) fail('COMPLETION_WORKER_RUNNING');
    return await configureThursdayPriority(store, registry, manifest, options);
  } finally { await release(); }
}

async function launchTuesdaySlice(manifest) {
  await copyWorker();
  Object.assign(manifest, { status: 'prepared', mode: 'tuesday-slice', pid: null, concurrency: 1,
    errorCode: null, updatedAt: new Date().toISOString() });
  await persistBackfillManifest(manifestFile, manifest);
  const log = await open(`${directory}/worker.log`, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [`--env-file=${productionApi}/.env`, workerScript, '--worker'],
      { cwd: workerApi, env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    await recordSpawnedWorker(manifest, child);
    return { id: COMPLETION_ID, started: true, status: 'prepared', mode: 'tuesday-slice', concurrency: 1, workerPid: child.pid };
  } finally { await log.close(); }
}

// Called under the same launch lock as ordinary starts. The injected readiness
// check reads the current Thursday source, not just its previous caught-up flag.
export async function launchDeferredTuesday(store, registry, manifest, {
  checkReadiness, inspectWorker = processState, launch = launchTuesdaySlice, now = () => new Date(),
  recordIntent = value => persistBackfillManifest(manifestFile, value),
} = {}) {
  assertCompletionPlan(manifest.plan);
  if (manifest.id !== COMPLETION_ID) fail('INVALID_COMPLETION_MANIFEST');
  if ((await inspectWorker(manifest.pid, workerScript)).alive) return { id: COMPLETION_ID, alreadyStarted: true };
  const readiness = await checkReadiness(now());
  if (!readiness.ready) return { id: COMPLETION_ID, started: false, reason: safeCode({ code: readiness.reason }) };
  // Persist the mode before claiming maintenance: an interrupted launch can be
  // restarted as a slice even if copy/spawn fails before the next manifest save.
  manifest.mode = 'tuesday-slice';
  await recordIntent(manifest);
  await store.transaction(state => claimDeferredTuesday(state, registry, manifest.plan, now()));
  try { return await launch(manifest); }
  catch (error) {
    // Failed copy/spawn may release the lease only after proving no owned child
    // survived. A spawned-but-unrecorded process is never treated as dead.
    try {
      if (!(await inspectWorker(manifest.pid, workerScript)).alive) {
        await blockTuesdayAfterFailure(store, registry, manifest.plan, error, now());
        Object.assign(manifest, deferredThursdayManifest(await store.read(), registry, manifest));
        await recordIntent(manifest);
      }
    } catch { /* Unknown child/task state keeps maintenance for active review. */ }
    throw error;
  }
}

export async function blockTuesdayAfterFailure(store, registry, plan, error, now = new Date()) {
  return store.transaction(state => {
    // This guard rejects every running job/task/attempt before releasing the
    // maintenance lease. Neither a timeout nor an unknown process proves safety.
    const result = deferTuesdayForThursday(state, registry, plan, now);
    state.settings.tuesdayWednesdayCompletion.priority.tuesdayBlocked = { code: safeCode(error), at: now.toISOString() };
    return result;
  });
}

async function resumeTuesday(store, registry, fullStore) {
  const { readDeferredTuesdayReadiness } = await import('../src/deferred-tuesday-readiness.js');
  const release = await acquireBackfillLock(`${incidentDirectory}/launch.lock`, COMPLETION_ID);
  try {
    const manifest = await readManifest(), incident = await readJson(incidentFile);
    if (!await verifyNoWorker(incident, manifest)) return { id: COMPLETION_ID, alreadyStarted: true };
    return await launchDeferredTuesday(store, registry, manifest, {
      checkReadiness: now => readDeferredTuesdayReadiness(fullStore, now),
    });
  } finally { await release(); }
}

export async function resumeDeferredTuesday() { return main(['--resume-tuesday']); }

async function start(store, registry, concurrency = 1) {
  const release = await acquireBackfillLock(`${incidentDirectory}/launch.lock`, COMPLETION_ID);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const incident = await readJson(incidentFile); let manifest = await optionalManifest();
    if (manifest?.mode === 'tuesday-slice' && concurrency !== 1) fail('INVALID_CONCURRENCY');
    if (!await verifyNoWorker(incident, manifest)) {
      const state = await store.read(), waiting = deferredThursdayManifest(state, registry, manifest);
      return { alreadyStarted: true, ...completionStatus(state, manifest.plan, waiting || manifest, true) };
    }
    if (manifest) {
      const state = await store.read(), waiting = deferredThursdayManifest(state, registry, manifest);
      if (waiting) {
        Object.assign(manifest, waiting);
        await persistBackfillManifest(manifestFile, manifest);
        return { alreadyStarted: true, reconciled: true, ...completionStatus(state, manifest.plan, manifest, false) };
      }
      const finishedAt = finalizedCompletion(state, registry, manifest.plan);
      if (finishedAt) {
        const fresh = manifest.mode === 'tuesday-slice' ? state
          : await store.readWithConversations({ fresh: true, conversationIds: completionSources(manifest.plan).map(c => c.id) });
        finalizedCompletion(fresh, registry, manifest.plan);
        if (manifest.mode !== 'tuesday-slice') assertCompletionSource(fresh, manifest.plan, completionSources(manifest.plan).map(c => c.id));
        await writeCompletedManifests(manifest, finishedAt);
        return { alreadyStarted: true, reconciled: true, ...completionStatus(fresh, manifest.plan, manifest, false) };
      }
      if (manifest.status === 'completed') fail('COMPLETION_STATE_CHANGED');
    }
    if (!manifest) {
      const { state, plan } = await freshPlan(store, registry, incident);
      await privateBackup(state, plan);
      manifest = { id: COMPLETION_ID, status: 'prepared', plan, createdAt: plan.createdAt, pid: null };
      await persistBackfillManifest(manifestFile, manifest);
      await store.transaction(s => { prepareCompletion(s, registry, plan, new Date().toISOString()); setCompletionConcurrency(s, plan, concurrency); });
    } else {
      await store.transaction(s => {
        // A prior attempt may have died before the initial preparation commit.
        if (!s.settings.tuesdayWednesdayCompletion) prepareCompletion(s, registry, manifest.plan, new Date().toISOString());
        assertCompletionStable(s, registry, manifest.plan);
        const jobs = new Set([...RECOVERY_JOBS, ...s.jobs.filter(j => Object.values(COMPLETION_KEYS).includes(j.idempotencyKey)).map(j => j.id)]);
        const allowed = new Set(completionTasks(s, manifest.plan).map(t => t.id));
        for (const j of s.jobs.filter(j => jobs.has(j.id) && j.status === 'running')) Object.assign(j, { status: 'interrupted', updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
        for (const t of s.tasks.filter(t => allowed.has(t.id) && t.status === 'running')) t.status = 'interrupted';
        for (const a of s.attempts.filter(a => allowed.has(a.taskId) && a.status === 'running')) Object.assign(a, { status: 'interrupted', finishedAt: new Date().toISOString() });
        Object.assign(s.settings.tuesdayWednesdayCompletion, { status: 'prepared' });
        setCompletionConcurrency(s, manifest.plan, concurrency);
      });
    }
    await copyWorker();
    Object.assign(manifest, { status: 'prepared', pid: null, concurrency, errorCode: null, updatedAt: new Date().toISOString() });
    await persistBackfillManifest(manifestFile, manifest);
    const log = await open(`${directory}/worker.log`, 'a', 0o600);
    try {
      const child = spawn(process.execPath, [`--env-file=${productionApi}/.env`, workerScript, '--worker'],
        { cwd: workerApi, env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd] });
      await recordSpawnedWorker(manifest, child);
      return { started: true, id: COMPLETION_ID, workerPid: child.pid, requestedConversations: 213, totalConversations: 212, excludedConversations: 1,
        exclusions: completionExclusions(manifest.plan), totalModelTasks: 422, preservedCompletedTasks: 725, concurrency };
    } finally { await log.close(); }
  } finally { await release(); }
}

// Injectable operations exercise actual phase orchestration without a provider.
export async function executeCompletion(store, registry, plan, { startBatch = startEvaluationBatch, resumeBatch = resumeEvaluationBatch, checkpoint = async () => {} } = {}) {
  const ids = completionSources(plan).map(c => c.id);
  const initial = await store.readWithConversations({ fresh: true, conversationIds: ids });
  assertCompletionStable(initial, registry, plan); assertCompletionSource(initial, plan, ids);
  const guarded = { read: () => store.read(), async readWithConversations(options) {
    const fresh = await store.readWithConversations(options); assertCompletionStable(fresh, registry, plan);
    assertCompletionSource(fresh, plan, options?.conversationIds || ids); return fresh;
  }, transaction: fn => store.transaction(s => { assertCompletionStable(s, registry, plan); return fn(s); }) };
  const run = async (phase, selected, findJob, begin) => {
    for (let round = 1; round <= 3; round++) {
      const state = await store.read(); assertCompletionStable(state, registry, plan);
      const job = findJob(state), tasks = job ? state.tasks.filter(t => t.jobId === job.id && selected.includes(t.conversationId)) : [];
      if (tasks.length && tasks.every(t => t.status === 'completed')) return;
      await checkpoint({ phase, round });
      const execution = job ? await resumeBatch(guarded, registry, job.id, { conversationIds: selected }) : await begin(guarded);
      await execution.completion;
      const after = await store.read(), unfinished = after.tasks.filter(t => t.jobId === execution.job.id && selected.includes(t.conversationId) && t.status !== 'completed');
      if (!unfinished.length) return;
      if (unfinished.some(t => ['AI_CONFIGURATION', 'MODEL_CHANGED', 'MODEL_IDENTITY_UNVERIFIED', 'SOURCE_CHANGED', 'PROMPT_CHANGED', 'CATALOG_CHANGED'].includes(t.error?.code))) fail('PROVIDER_REQUIRES_INTERVENTION');
    }
    fail('COMPLETION_RETRIES_EXHAUSTED');
  };
  for (const jobId of RECOVERY_JOBS) {
    const selected = completionRetry(plan).filter(t => t.jobId === jobId).map(t => t.id); if (!selected.length) continue;
    await run('retry-tuesday', selected, s => s.jobs.find(j => j.id === jobId), () => fail('RECOVERY_JOB_MISSING'));
  }
  // Populate Wednesday first; an existing Tuesday job resumes afterwards.
  for (const phase of ['wednesday', 'tuesday']) {
    if (phase === 'tuesday') {
      const state = await store.read();
      if (state.settings.tuesdayWednesdayCompletion?.priority?.order === 'wednesday-thursday-tuesday') {
        const deferred = await store.transaction(s => deferTuesdayForThursday(s, registry, plan));
        await checkpoint({ status: 'waiting_thursday', phase: 'waiting_thursday' });
        return deferred;
      }
    }
    const selected = plan[phase].map(c => c.id);
    await run(phase, selected, s => assertPhaseJob(s, plan, phase), async guardedStore => {
      const source = await guardedStore.readWithConversations({ fresh: true, conversationIds: selected });
      assertCompletionSource(source, plan, selected, true);
      return startBatch(guardedStore, registry, { purpose: 'operational', conversationIds: selected, pendingOnly: true,
        refreshChanged: false, includeOpen: true, max: selected.length, largeBatch: true, maintenanceId: RECOVERY_ID,
        modelIds: COMPLETION_MODELS, executionOrder: 'conversation-first', concurrency: source.settings.tuesdayWednesdayCompletion.concurrency || 1,
        idempotencyKey: COMPLETION_KEYS[phase], author: { id: null, name: 'Finalización martes y miércoles autorizada' } });
    });
  }
}

export async function executeTuesdaySlice(store, registry, plan, {
  resumeBatch = resumeEvaluationBatch, checkpoint = async () => {}, now = () => new Date(),
} = {}) {
  const initial = await store.read();
  assertCompletionStable(initial, registry, plan);
  const priority = initial.settings.tuesdayWednesdayCompletion.priority;
  if (priority?.order !== 'wednesday-thursday-tuesday' || priority.resumeTuesday !== 'automatic_before_noon'
    || initial.settings.tuesdayWednesdayCompletion.concurrency !== 1) fail('TUESDAY_AUTOMATIC_NOT_AUTHORIZED');
  const job = assertPhaseJob(initial, plan, 'tuesday');
  if (!job || job.concurrency !== 1) fail('TUESDAY_JOB_CHANGED');
  const selected = plan.tuesday.find(item => initial.tasks.some(task => task.jobId === job.id && task.conversationId === item.id && task.status !== 'completed'));
  if (!selected) return;
  if (now().toISOString() < priority.deadline) {
    const ids = [selected.id];
    const guarded = { read: () => store.read(), async readWithConversations(options) {
      const scope = options?.conversationIds || ids;
      if (scope.length !== 1 || scope[0] !== selected.id) fail('TUESDAY_SLICE_SCOPE_CHANGED');
      const state = await store.readWithConversations({ ...options, fresh: true, conversationIds: ids });
      assertCompletionStable(state, registry, plan); assertCompletionSource(state, plan, ids); return state;
    }, transaction: fn => store.transaction(state => { assertCompletionStable(state, registry, plan); return fn(state); }) };
    // Only the unfinished conversation's source is read. Already completed
    // Wednesday/Tuesday sources may evolve without invalidating their answers.
    await guarded.readWithConversations({ conversationIds: ids });
    await checkpoint({ phase: 'tuesday', mode: 'tuesday-slice' });
    if (now().toISOString() < priority.deadline) {
      const execution = await resumeBatch(guarded, registry, job.id, { conversationIds: ids });
      await execution.completion;
      const after = await store.read();
      if (after.tasks.some(task => task.jobId === job.id && task.conversationId === selected.id && task.status !== 'completed')) fail('TUESDAY_SLICE_INCOMPLETE');
    }
  }
  const after = await store.read(), tasks = completionTasks(after, plan);
  if (tasks.length === 422 && tasks.every(task => task.status === 'completed')) return;
  const deferred = await store.transaction(state => deferTuesdayForThursday(state, registry, plan, now()));
  await checkpoint({ status: 'waiting_thursday', phase: 'waiting_thursday', mode: 'tuesday-slice' });
  return deferred;
}

async function writeCompletedManifests(manifest, finishedAt) {
  const incident = await readJson(incidentFile);
  if (incident.id !== RECOVERY_ID || incident.plan?.id !== RECOVERY_ID) fail('INCIDENT_MANIFEST_CHANGED');
  Object.assign(incident, { status: 'partial', errorCode: null, updatedAt: finishedAt, completedAt: null,
    exclusions: completionExclusions(manifest.plan), exclusionReason: COMPLETION_EXCLUSION_REASON });
  await persistBackfillManifest(incidentFile, incident);
  Object.assign(manifest, { status: 'completed', finishedAt, updatedAt: finishedAt, errorCode: null });
  await persistBackfillManifest(manifestFile, manifest);
}

export async function executeCompletionWorker(store, registry, manifest, {
  execute = manifest.mode === 'tuesday-slice' ? executeTuesdaySlice : executeCompletion,
  persist = persistBackfillManifest, writeCompleted = writeCompletedManifests,
} = {}) {
  try {
    await execute(store, registry, manifest.plan, { checkpoint: async progress => {
      Object.assign(manifest, progress, { updatedAt: new Date().toISOString() }); await persist(manifestFile, manifest);
    } });
    const waiting = deferredThursdayManifest(await store.read(), registry, manifest);
    if (waiting) {
      Object.assign(manifest, waiting);
      await persist(manifestFile, manifest);
      return completionStatus(await store.read(), manifest.plan, manifest, false);
    }
    const finishedAt = new Date().toISOString();
    await store.transaction(s => finishCompletion(s, registry, manifest.plan, finishedAt));
    await writeCompleted(manifest, finishedAt);
    return completionStatus(await store.read(), manifest.plan, manifest, false);
  } catch (error) {
    if (manifest.mode === 'tuesday-slice') {
      try {
        await blockTuesdayAfterFailure(store, registry, manifest.plan, error);
        Object.assign(manifest, deferredThursdayManifest(await store.read(), registry, manifest));
        await persist(manifestFile, manifest);
      } catch { /* An in-flight/unknown evaluation must not lose its lease. */ }
    }
    throw error;
  }
}

async function worker(store, registry) {
  await waitForWorkerAssignment(process.pid);
  const release = await acquireBackfillLock(`${incidentDirectory}/worker.lock`, COMPLETION_ID);
  let manifest;
  try {
    manifest = await readManifest(); if (manifest.status !== 'prepared' || manifest.pid !== process.pid) fail('WORKER_ALREADY_STARTED');
    Object.assign(manifest, { status: 'running', pid: process.pid, startedAt: manifest.startedAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
    await persistBackfillManifest(manifestFile, manifest);
    console.log(JSON.stringify(await executeCompletionWorker(store, registry, manifest)));
  } catch (error) {
    if (manifest) {
      const waiting = deferredThursdayManifest(await store.read(), registry, manifest);
      if (waiting) {
        // Preserve an already committed handoff even if its filesystem update
        // failed. A later status projects it; a later start persists it safely.
        Object.assign(manifest, waiting);
        await persistBackfillManifest(manifestFile, manifest).catch(() => {});
        throw error;
      }
      Object.assign(manifest, { status: 'blocked', errorCode: safeCode(error), updatedAt: new Date().toISOString() });
      await persistBackfillManifest(manifestFile, manifest);
      await store.transaction(s => { if (s.settings.evaluationMaintenance === RECOVERY_ID && s.settings.tuesdayWednesdayCompletion?.id === COMPLETION_ID) Object.assign(s.settings.tuesdayWednesdayCompletion, { status: 'blocked', errorCode: safeCode(error), updatedAt: manifest.updatedAt }); }).catch(() => {});
    }
    throw error;
  } finally { await release(); }
}

export function parseCompletionArguments(args) {
  if (args.length === 5 && args[0] === '--prioritize-thursday' && args[1] === '--expected-version'
    && /^[1-9]\d*(?![\s\S])/.test(args[2]) && Number.isSafeInteger(Number(args[2]))
    && args[3] === '--resume-tuesday' && ['manual', 'automatic_before_noon'].includes(args[4])) {
    return { mode: '--prioritize-thursday', expectedVersion: Number(args[2]), resumeTuesday: args[4] };
  }
  const concurrency = args[1] === '--concurrency=2' ? 2 : 1;
  if (!['--inspect', '--start', '--status', '--worker', '--stop', '--resume-tuesday'].includes(args[0]) || args.length > 2 || args.length === 2 && (args[0] !== '--start' || !['--concurrency=1', '--concurrency=2'].includes(args[1]))) fail('INVALID_ARGUMENTS');
  return { mode: args[0], concurrency };
}

export async function main(args) {
  const options = parseCompletionArguments(args), { mode, concurrency } = options;
  // Stopping requires only the private manifest and OS identity. Do not open
  // either database or wait on an in-flight evaluation transaction first.
  if (mode === '--stop') return stop();
  const { config, databaseConfig, atomDatabaseConfig } = await import('../src/config.js');
  const { MysqlStore, AtomHistoryStore } = await import('../src/store.js');
  const { CompletionStore } = await import('../src/tuesday-wednesday-completion-store.js');
  const { AtomReader } = await import('../src/atom.js');
  const { registryFromEnv } = await import('../src/model-registry.js');
  const db = databaseConfig(), atom = atomDatabaseConfig();
  if (config.demo || db?.database !== 'dbPulsosAtom' || !atom) fail('REAL_MODE_REQUIRED');
  const existing = await optionalManifest();
  if (mode === '--status' && !existing) return { id: COMPLETION_ID, status: 'not_started', workerAlive: false };
  if (['--prioritize-thursday', '--resume-tuesday'].includes(mode) && !existing) fail('COMPLETION_NOT_PREPARED');
  const base = existing ? new CompletionStore(db, existing.plan) : new MysqlStore(db);
  const store = new AtomHistoryStore(base, new AtomReader(atom, config.timezone));
  let fullStore;
  try {
    const registry = registryFromEnv();
    if (mode === '--inspect') return await inspect(store, registry);
    if (mode === '--start') return await start(store, registry, concurrency);
    if (mode === '--worker') return await worker(store, registry);
    if (mode === '--prioritize-thursday') return await prioritizeThursday(store, registry, options);
    if (mode === '--resume-tuesday') {
      fullStore = new AtomHistoryStore(new MysqlStore(db), new AtomReader(atom, config.timezone));
      return await resumeTuesday(store, registry, fullStore);
    }
    const state = await store.read(), manifest = deferredThursdayManifest(state, registry, existing) || existing;
    return completionStatus(state, existing.plan, manifest, (await processState(existing.pid, workerScript)).alive);
  } finally { await Promise.all([store.close(), fullStore?.close()]); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(result => {
  if (result) console.log(JSON.stringify(result, null, 2));
}).catch(error => { console.error(JSON.stringify({ success: false, errorCode: safeCode(error) })); process.exitCode = 1; });
