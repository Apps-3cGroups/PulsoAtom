import { pathToFileURL } from 'node:url';
import { cp, mkdir, open, readFile, symlink, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
    'AI_SAFETY_REFUSAL', 'UNSUPPORTED_VARIABLE', 'AI_INVALID_RESPONSE', 'AI_TIMEOUT', 'AI_UNAVAILABLE']);
  const taskErrorCounts = {};
  for (const task of tasks) {
    if (!task.error) continue;
    const code = knownErrorCodes.has(task.error.code) ? task.error.code : 'OTHER_ERROR';
    taskErrorCounts[code] = (taskErrorCounts[code] || 0) + 1;
  }
  let workerAlive = false;
  if (Number.isInteger(manifest.pid)) { try { process.kill(manifest.pid, 0); workerAlive = true; } catch {} }
  return { cohortId, total: 500, status: manifest.status, workerAlive, startedAt: manifest.startedAt || null,
    updatedAt: manifest.updatedAt, model: manifest.profile.model, completed: counts('completed'), partial: counts('partial'),
    failed: counts('failed'), running: counts('running'), pending: 500 - counts('completed') - counts('partial') - counts('failed') - counts('running'),
    batchesCreated: jobs.length, comparisonIds: jobs.map(job => job.id), taskErrorCounts,
    originalRecordsPreserved: originalsPreserved(state, manifest.baseline), dailyPaused: state.settings.dailyEnabled === false,
    ...(manifest.errorCode ? { errorCode: manifest.errorCode } : {}) };
}
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
    if (resume ? !['blocked', 'partial', 'running'].includes(manifest.status) : manifest.status !== 'prepared') fail('WORKER_ALREADY_STARTED');
    if (resume) await recoverEvaluationJobs(store);
    manifest.status = 'running'; manifest.pid = process.pid; manifest.startedAt = new Date().toISOString();
    manifest.updatedAt = manifest.startedAt;
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
      const eligibleIds = existing ? state.tasks.filter(task => task.jobId === existing.id && task.profile.id === 'clef-local'
        && task.status !== 'completed' && task.round < 3).map(task => task.conversationId) : ids;
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
      if (currentTasks.some(task => ['AI_CONFIGURATION','MODEL_CHANGED','MODEL_IDENTITY_UNVERIFIED','AI_SAFETY_REFUSAL','UNSUPPORTED_VARIABLE'].includes(task.error?.code))) fail('MODEL_REQUIRES_INTERVENTION');
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
    try {
      const { manifest } = await readManifest();
      const state = await store.read(), status = cohortStatus(state, manifest);
      if (!resume || status.workerAlive || manifest.status === 'completed') return { alreadyPrepared: true, ...status };
      assertStable(state, manifest, registry);
      return launchWorker(store, true);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
    return launchWorker(store);
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
