import { pathToFileURL } from 'node:url';
import { cp, mkdir, open, readFile, symlink, rename, readdir, lstat, realpath } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { apiRoot, config, databaseConfig, atomDatabaseConfig } from '../src/config.js';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { AtomReader } from '../src/atom.js';
import { registryFromEnv } from '../src/model-registry.js';
import { digest, catalogReferences } from '../src/evaluation-context.js';
import { resumeEvaluationBatch, recoverEvaluationJobs } from '../src/evaluation-service.js';
import { createClefCohortBatch } from '../src/clef-cohort.js';
import { readRequiredBackfillManifest, persistBackfillManifest, acquireBackfillLock } from '../src/gemma-backfill.js';
import { inspectClefCohort, ORIGINAL_GEMMA_MANIFEST, ORIGINAL_GEMMA_MAINTENANCE_ID as maintenanceId } from './inspect-clef-cohort.js';
import { configureClefFlash } from './configure-clef-flash.js';

const productionApi = '/var/www/nodeapps/PulsoAtom/api';
const directory = `${productionApi}/.data/clef-cohort-${maintenanceId}`;
const manifestFile = `${directory}/manifest.json`;
const cohortId = `clef-complement-${maintenanceId}`;
const fail = code => { throw Object.assign(new Error('Clef cohort operation stopped'), { cohortCode: code }); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => digest(canonical(value));
const baselineFields = ['evaluations', 'tasks', 'attempts', 'jobs', 'comparisons', 'operationalRefs', 'reviews', 'verdicts'];
const codeRoots = new Set(['src', 'scripts']);
const codeRootFiles = new Set(['server.js', 'package.json', 'package-lock.json']);
const skippedDirectories = new Set(['node_modules', '.data', '.git']);
const safeCodeExtension = /\.(?:js|mjs|cjs|json|py)$/;
const processAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

// Hash/copy only executable source, its catalogs and package metadata. Runtime
// output, credentials and dependencies never enter the reviewed snapshot.
async function codeInventory(root) {
  const entries = [];
  async function visit(relative = '') {
    const names = (await readdir(path.join(root, relative))).sort();
    for (const name of names) {
      if (name.startsWith('.env') || skippedDirectories.has(name)) continue;
      if (!relative && !codeRoots.has(name) && !codeRootFiles.has(name)) continue;
      const file = path.join(relative, name), absolute = path.join(root, file);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) fail('WORKER_CODE_SYMLINK');
      if (info.isDirectory()) { if (relative || codeRoots.has(name)) await visit(file); continue; }
      if (!info.isFile() || !safeCodeExtension.test(name)) continue;
      entries.push({ file, hash: createHash('sha256').update(await readFile(absolute)).digest('hex') });
    }
  }
  await visit();
  if (!entries.some(entry => entry.file === path.join('scripts', 'start-clef-cohort.js'))
    || !entries.some(entry => entry.file === path.join('src', 'evaluation-service.js'))
    || !entries.some(entry => entry.file === 'package.json')) fail('INCOMPLETE_WORKER_CODE');
  return { entries, hash: fingerprint(entries) };
}
async function syncDirectory(filename) {
  const handle = await open(filename, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// The caller owns both launch.lock and worker.lock. The guard is rechecked
// after staging and immediately before swapping, including the dead PID and
// immutable cohort/configuration checks. Backups and journals are retained.
export async function refreshWorkerSnapshot({ sourceApi, cohortDirectory, dependenciesPath, verifyStopped,
  expectedPreviousHash, renamePath = rename, now = new Date().toISOString() }) {
  if (typeof verifyStopped !== 'function' || !Number.isFinite(Date.parse(now))) fail('INVALID_WORKER_UPDATE');
  await verifyStopped();
  const source = await realpath(sourceApi), workerApi = path.join(cohortDirectory, 'worker-api');
  const worker = await realpath(workerApi);
  if (source === worker || source.startsWith(`${worker}${path.sep}`)) fail('WORKER_SOURCE_NOT_REVIEWED');
  const sourceCode = await codeInventory(source), previousCode = await codeInventory(worker);
  if (expectedPreviousHash && previousCode.hash !== expectedPreviousHash) fail('WORKER_CODE_CHANGED');
  const updateId = randomUUID(), stagingApi = path.join(cohortDirectory, `worker-api-${updateId}.tmp`);
  const backupApi = path.join(cohortDirectory, `worker-api-backup-${updateId}`);
  const journalFile = path.join(cohortDirectory, `worker-update-${updateId}.json`);
  await mkdir(stagingApi, { mode: 0o700 });
  for (const entry of sourceCode.entries) {
    const target = path.join(stagingApi, entry.file);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await cp(path.join(source, entry.file), target, { force: false, errorOnExist: true });
    const copied = await open(target, 'r');
    try { await copied.sync(); } finally { await copied.close(); }
  }
  const stagedCode = await codeInventory(stagingApi), sourceAfter = await codeInventory(source);
  if (stagedCode.hash !== sourceCode.hash || sourceAfter.hash !== sourceCode.hash) fail('WORKER_SOURCE_CHANGED');
  await symlink(dependenciesPath, path.join(stagingApi, 'node_modules'));
  const stagedDirectories = [...new Set(stagedCode.entries.map(entry => path.dirname(path.join(stagingApi, entry.file))))];
  for (const stagedDirectory of stagedDirectories.sort((a, b) => b.length - a.length)) await syncDirectory(stagedDirectory);
  await syncDirectory(stagingApi);
  const journal = { format: 1, updateId, status: 'staged', createdAt: now,
    previousCodeHash: previousCode.hash, codeHash: stagedCode.hash,
    backupDirectory: path.basename(backupApi), stagedDirectory: path.basename(stagingApi), files: stagedCode.entries.length };
  await persistBackfillManifest(journalFile, journal);
  await verifyStopped();
  if ((await codeInventory(workerApi)).hash !== previousCode.hash) fail('WORKER_CODE_CHANGED');
  let backedUp = false, installed = false;
  try {
    await renamePath(workerApi, backupApi); backedUp = true;
    await renamePath(stagingApi, workerApi); installed = true;
    await syncDirectory(cohortDirectory);
    if ((await codeInventory(workerApi)).hash !== stagedCode.hash) fail('WORKER_INSTALL_MISMATCH');
    journal.status = 'installed'; journal.installedAt = new Date().toISOString();
    await persistBackfillManifest(journalFile, journal);
    return { ...journal, journalFile: path.basename(journalFile) };
  } catch (error) {
    // Preserve the new staging copy for diagnosis and restore the old runnable
    // directory if the second rename fails. Never remove outputs or backups.
    if (backedUp && !installed) {
      try { await renamePath(backupApi, workerApi); await syncDirectory(cohortDirectory); journal.status = 'rolled-back'; }
      catch { journal.status = 'recovery-required'; }
    } else journal.status = installed ? 'installed-unconfirmed' : 'failed';
    await persistBackfillManifest(journalFile, journal).catch(() => {});
    throw error;
  }
}

export function workerRunManifest(manifest, { resume = false, pid = process.pid, now = new Date().toISOString() } = {}) {
  if (resume ? !['blocked', 'partial', 'running'].includes(manifest.status) : manifest.status !== 'prepared') fail('WORKER_ALREADY_STARTED');
  if (!Number.isFinite(Date.parse(now)) || !Number.isSafeInteger(pid) || pid < 1
    || (manifest.startedAt && !Number.isFinite(Date.parse(manifest.startedAt)))) fail('INVALID_WORKER_START');
  const next = structuredClone(manifest);
  next.workerRuns ||= [];
  next.workerRuns.push({ pid, startedAt: now, resume, previousStatus: manifest.status,
    ...(manifest.errorCode ? { previousErrorCode: manifest.errorCode } : {}),
    ...(manifest.finishedAt ? { previousFinishedAt: manifest.finishedAt } : {}) });
  next.status = 'running'; next.pid = pid; next.startedAt ||= now;
  next.lastStartedAt = now; next.updatedAt = now;
  delete next.errorCode; delete next.finishedAt;
  return next;
}
export function preservationBaseline(state) {
  return Object.fromEntries(baselineFields.map(field => [field, (state[field] || []).map(record => ({ id: record.id, hash: fingerprint(record) }))]));
}
export function originalsPreserved(state, baseline) {
  return baselineFields.every(field => {
    const records = new Map((state[field] || []).map(record => [record.id, record]));
    return baseline[field].every(record => records.has(record.id) && fingerprint(records.get(record.id)) === record.hash);
  });
}
export function cohortStatus(state, manifest) {
  const jobs = state.jobs.filter(job => job.cohortId === cohortId);
  const jobIds = new Set(jobs.map(job => job.id));
  const tasks = state.tasks.filter(task => jobIds.has(task.jobId) && task.profile.id === 'clef-local');
  const counts = status => tasks.filter(task => task.status === status).length;
  const knownErrorCodes = new Set(['AI_CONFIGURATION', 'MODEL_CHANGED', 'MODEL_IDENTITY_UNVERIFIED',
    'AI_SAFETY_REFUSAL', 'UNSUPPORTED_VARIABLE', 'INVALID_AI_RESULT', 'AI_INCOMPLETE', 'AI_TRANSIENT', 'AI_UNAVAILABLE', 'AI_CONTEXT_LIMIT']);
  const taskErrorCounts = {};
  for (const task of tasks) {
    if (!task.error) continue;
    const code = knownErrorCodes.has(task.error.code) ? task.error.code : 'OTHER_ERROR';
    taskErrorCounts[code] = (taskErrorCounts[code] || 0) + 1;
  }
  const workerAlive = processAlive(manifest.pid);
  return { cohortId, total: 500, status: manifest.status, workerAlive, startedAt: manifest.startedAt || null,
    lastStartedAt: manifest.lastStartedAt || manifest.startedAt || null,
    resumeCount: (manifest.workerRuns || []).filter(run => run.resume).length, workerCodeHash: manifest.workerCodeHash || null,
    updatedAt: manifest.updatedAt, model: manifest.profile.model, completed: counts('completed'), partial: counts('partial'),
    failed: counts('failed'), running: counts('running'), pending: 500 - counts('completed') - counts('partial') - counts('failed') - counts('running'),
    batchesCreated: jobs.length, comparisonIds: jobs.map(job => job.id), taskErrorCounts,
    originalRecordsPreserved: originalsPreserved(state, manifest.baseline), dailyPaused: state.settings.dailyEnabled === false,
    ...(manifest.errorCode ? { errorCode: manifest.errorCode } : {}) };
}
export const requiresModelIntervention = task => ['AI_CONFIGURATION', 'MODEL_CHANGED', 'MODEL_IDENTITY_UNVERIFIED',
  'AI_SAFETY_REFUSAL', 'UNSUPPORTED_VARIABLE'].includes(task.error?.code);
export const eligibleForCohortResume = task => task.profile.id === 'clef-local' && task.status !== 'completed'
  && task.round < 3 && !['AI_CONTEXT_LIMIT', 'AI_SAFETY_REFUSAL'].includes(task.error?.code);
function assertStable(state, manifest, registry) {
  if (state.settings.dailyEnabled !== false || state.settings.evaluationMaintenance !== maintenanceId) fail('MAINTENANCE_CHANGED');
  if (!originalsPreserved(state, manifest.baseline)) fail('ORIGINAL_RECORD_CHANGED');
  const bound = registry.forState(state);
  bound.resolve('clef-local', manifest.profile);
  bound.resolve('gemma-local', manifest.gemmaProfile);
  if (fingerprint(state.settings.aiPolicy) !== manifest.policyHash) fail('POLICY_CHANGED');
  if (digest(catalogReferences(state.catalog)) !== manifest.catalogHash) fail('CATALOG_CHANGED');
}
async function readManifest() {
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.format !== 1 || manifest.cohortId !== cohortId || manifest.originalMaintenanceId !== maintenanceId
    || manifest.conversationIds.length !== 500 || new Set(manifest.conversationIds).size !== 500
    || manifest.profile?.id !== 'clef-local' || manifest.profile.model !== 'clef-flash') fail('INVALID_COHORT_MANIFEST');
  const original = await readRequiredBackfillManifest(ORIGINAL_GEMMA_MANIFEST);
  if (original.integrityHash !== manifest.originalIntegrityHash
    || fingerprint(original.conversations.map(item => item.id)) !== fingerprint(manifest.conversationIds)) fail('ORIGINAL_COHORT_CHANGED');
  return { manifest, original };
}
async function runWorker(store, registry, resume = false) {
  const release = await acquireBackfillLock(`${directory}/worker.lock`, maintenanceId);
  let manifest;
  try {
    const read = await readManifest(); manifest = read.manifest;
    const nextRun = workerRunManifest(manifest, { resume });
    const beforeRecovery = await store.read();
    assertStable(beforeRecovery, manifest, registry);
    if (beforeRecovery.jobs.some(job => ['running', 'pending', 'queued'].includes(job.status)
      && job.cohortId !== cohortId)) fail('EVALUATION_RUNNING');
    if (resume) await recoverEvaluationJobs(store);
    manifest = nextRun;
    await persistBackfillManifest(manifestFile, manifest);
    for (let index = 0; index < 25; index++) {
      const ids = manifest.conversationIds.slice(index * 20, (index + 1) * 20);
      const state = await store.readWithConversations({ fresh: true, conversationIds: ids });
      assertStable(state, manifest, registry);
      if (state.jobs.some(job => ['running', 'pending', 'queued'].includes(job.status))) fail('EVALUATION_RUNNING');
      const existing = state.jobs.find(job => job.idempotencyKey === `${cohortId}:${index}`);
      if (existing && !resume) fail('COHORT_BATCH_ALREADY_CREATED');
      if (existing && (existing.cohortId !== cohortId || existing.cohortManifestHash !== manifest.originalIntegrityHash
        || fingerprint(existing.conversationIds) !== fingerprint(ids))) fail('COHORT_BATCH_CHANGED');
      const prepared = existing ? { job: existing } : createClefCohortBatch(state, read.original, manifest.profile, ids, index);
      // A transaction rechecks persisted prerequisites without copying Atom data
      // or overwriting any Gemma result, task, review or operational reference.
      if (!existing) await store.transaction(draft => {
        assertStable(draft, manifest, registry);
        if (draft.jobs.some(job => ['running', 'pending', 'queued'].includes(job.status))) fail('EVALUATION_RUNNING');
        if (draft.jobs.some(job => job.idempotencyKey === prepared.job.idempotencyKey)) fail('DUPLICATE_BATCH');
        draft.jobs.push(prepared.job); draft.tasks.push(...prepared.tasks); draft.comparisons.push(prepared.sample);
      });
      const eligibleIds = existing ? state.tasks.filter(task => task.jobId === existing.id
        && eligibleForCohortResume(task)).map(task => task.conversationId) : ids;
      if (!eligibleIds.length) continue;
      console.log(JSON.stringify({ event: 'clef-cohort-batch-start', batch: index + 1, jobId: prepared.job.id, conversations: ids.length }));
      const launched = await resumeEvaluationBatch(store, registry, prepared.job.id, { profileIds: ['clef-local'], conversationIds: eligibleIds });
      await launched.completion;
      const after = await store.read(); assertStable(after, manifest, registry);
      manifest.updatedAt = new Date().toISOString(); manifest.finishedBatches = index + 1;
      await persistBackfillManifest(manifestFile, manifest);
      const status = cohortStatus(after, manifest);
      console.log(JSON.stringify({ event: 'clef-cohort-progress', ...status, comparisonIds: undefined }));
      // A configuration/refusal failure requires intervention. Do not consume
      // the remaining 480 requests after a systematic non-transient failure.
      const currentTasks = after.tasks.filter(task => task.jobId === prepared.job.id && task.profile.id === 'clef-local');
      if (currentTasks.some(requiresModelIntervention)) fail('MODEL_REQUIRES_INTERVENTION');
    }
    const state = await store.read(); assertStable(state, manifest, registry);
    const status = cohortStatus(state, manifest);
    manifest.status = status.partial || status.failed ? 'partial' : 'completed';
    manifest.updatedAt = new Date().toISOString(); manifest.finishedAt = manifest.updatedAt;
    await persistBackfillManifest(manifestFile, manifest);
    console.log(JSON.stringify({ event: 'clef-cohort-finished', ...cohortStatus(state, manifest), comparisonIds: undefined }));
  } catch (error) {
    if (manifest) {
      manifest.status = 'blocked'; manifest.errorCode = error.cohortCode || (/^[A-Z_]{3,80}$/.test(error.code || '') ? error.code : 'COHORT_WORKER_FAILED');
      manifest.updatedAt = new Date().toISOString();
      await persistBackfillManifest(manifestFile, manifest).catch(() => {});
      console.error(JSON.stringify({ event: 'clef-cohort-stopped', code: manifest.errorCode }));
    }
    throw error;
  } finally { await release(); }
}
async function launchWorker(store, resume = false) {
  const workerApi = `${directory}/worker-api`;
  const log = await open(`${directory}/worker.log`, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [`--env-file=${productionApi}/.env`, `${workerApi}/scripts/start-clef-cohort.js`, resume ? '--worker-resume' : '--worker'],
      { cwd: workerApi, env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    await new Promise(resolve => setTimeout(resolve, 3000));
    const observed = await readManifest();
    const status = cohortStatus(await store.read(), observed.manifest);
    return { launched: status.workerAlive && status.status === 'running', pid: child.pid, ...status };
  } finally { await log.close(); }
}
async function start(store, registry, resume = false) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquireBackfillLock(`${directory}/launch.lock`, maintenanceId);
  try {
    let prepared;
    try {
      prepared = await readManifest();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (prepared) {
      const { manifest } = prepared;
      const state = await store.read(), status = cohortStatus(state, manifest);
      if (!resume || status.workerAlive || manifest.status === 'completed') return { alreadyPrepared: true, ...status };
      assertStable(state, manifest, registry);
      if (!['blocked', 'partial', 'running'].includes(manifest.status)) fail('WORKER_ALREADY_STARTED');
      const releaseWorker = await acquireBackfillLock(`${directory}/worker.lock`, maintenanceId);
      try {
        const expectedManifest = fingerprint(manifest);
        const verifyStopped = async () => {
          const current = (await readManifest()).manifest;
          if (fingerprint(current) !== expectedManifest) fail('COHORT_MANIFEST_CHANGED');
          if (processAlive(current.pid)) fail('WORKER_STILL_RUNNING');
          const latest = await store.read(); assertStable(latest, manifest, registry);
          // A stale job from this stopped worker may be recovered by the new
          // worker. All other live work prevents installing another runtime.
          if (latest.jobs.some(job => ['running', 'pending', 'queued'].includes(job.status)
            && !(job.cohortId === cohortId && job.status === 'running'
              && Date.parse(job.updatedAt || job.createdAt) < Date.now() - 10 * 60_000))) fail('EVALUATION_RUNNING');
        };
        const update = await refreshWorkerSnapshot({ sourceApi: apiRoot, cohortDirectory: directory,
          dependenciesPath: `${productionApi}/node_modules`, verifyStopped, expectedPreviousHash: manifest.workerCodeHash });
        await verifyStopped();
        manifest.workerCodeUpdates ||= [];
        manifest.workerCodeUpdates.push(update);
        manifest.workerCodeHash = update.codeHash;
        await persistBackfillManifest(manifestFile, manifest);
      } finally { await releaseWorker(); }
      return await launchWorker(store, true);
    }
    if (resume) fail('COHORT_NOT_PREPARED');
    const original = await readRequiredBackfillManifest(ORIGINAL_GEMMA_MANIFEST);
    const state = await store.readWithConversations({ fresh: true, conversationIds: original.conversations.map(item => item.id) });
    const inspection = inspectClefCohort(state, original, registry);
    if (!inspection.readyForCohortAugmentation || inspection.checklist.currentHash !== inspection.checklist.originalHash) fail('COHORT_NOT_EQUIVALENT');
    const { default: mysql } = await import('mysql2/promise');
    const { connectionLimit, ...options } = databaseConfig();
    const connection = await mysql.createConnection(options);
    try { await configureClefFlash(connection, { apply: true }); } finally { await connection.end(); }
    const updated = await store.read();
    const models = registry.forState(updated), profile = models.snapshot(models.resolve('clef-local'));
    if (profile.model !== 'clef-flash' || profile.protocol !== 'chat' || profile.decisionInstructionsVersion !== 'clef-flash-decisions-1') fail('CLEF_PROFILE_INVALID');
    models.resolve('gemma-local', original.profile);
    // Same source as the published revision plus the scoped worker extension.
    // The workflow's temporary copy is removed; this private copy survives it.
    const workerApi = `${directory}/worker-api`;
    const stagingApi = `${directory}/worker-api-${randomUUID()}.tmp`;
    await cp(apiRoot, stagingApi, { recursive: true, force: false, errorOnExist: true,
      filter: source => !['node_modules','.data','.env'].includes(path.basename(source)) });
    await symlink(`${productionApi}/node_modules`, `${stagingApi}/node_modules`);
    await rename(stagingApi, workerApi);
    const createdAt = new Date().toISOString();
    const manifest = { format: 1, cohortId, originalMaintenanceId: maintenanceId, originalIntegrityHash: original.integrityHash,
      conversationIds: original.conversations.map(item => item.id), profile, gemmaProfile: original.profile,
      policyHash: fingerprint(updated.settings.aiPolicy), catalogHash: inspection.checklist.originalHash,
      baseline: preservationBaseline(updated), status: 'prepared', createdAt, updatedAt: createdAt, finishedBatches: 0 };
    await persistBackfillManifest(manifestFile, manifest);
    // Worker owns the manifest after spawn; never overwrite its checkpoint.
    return await launchWorker(store);
  } finally { await release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let store;
  try {
    const mode = process.argv[2];
    if (process.argv.length !== 3 || !['--start','--resume','--worker','--worker-resume','--status'].includes(mode)) fail('INVALID_ARGUMENTS');
    const db = databaseConfig(), atom = atomDatabaseConfig();
    if (config.demo || db?.database !== 'dbPulsosAtom' || !atom) fail('REAL_MODE_REQUIRED');
    store = new AtomHistoryStore(new MysqlStore(db), new AtomReader(atom, config.timezone));
    const registry = registryFromEnv();
    if (['--worker', '--worker-resume'].includes(mode)) await runWorker(store, registry, mode === '--worker-resume');
    else {
      const result = ['--start', '--resume'].includes(mode) ? await start(store, registry, mode === '--resume') : cohortStatus(await store.read(), (await readManifest()).manifest);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(JSON.stringify({ success: false, code: error.cohortCode || (/^[A-Z_]{3,80}$/.test(error.code || '') ? error.code : 'CLEF_COHORT_FAILED'),
      message: 'Consulta el estado antes de reintentar. No se borraron evaluaciones previas.' }));
    process.exitCode = 1;
  } finally { await store?.close(); }
}
