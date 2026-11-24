import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, chmod, rename, open, unlink } from 'node:fs/promises';
import { config, databaseConfig, atomDatabaseConfig } from '../src/config.js';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { AtomReader } from '../src/atom.js';
import { registryFromEnv } from '../src/model-registry.js';
import { AppError } from '../src/errors.js';
import { validateFreshReviewManifest, assertFreshReviewSources, freshReviewConfiguration, freshReviewChunks,
  executeFreshReview, completedFreshReviewSelection } from '../src/fresh-review-run.js';

const apiDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'REVIEW_RUN_FAILED';
const log = value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));
const fail = (code, message) => { throw new AppError(409, message, code); };
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;

export function parseReviewArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--check', '--run', '--publish', '--status'].includes(argument)) {
      if (options.mode) fail('INVALID_ARGUMENTS', 'Selecciona sólo un modo.');
      options.mode = argument.slice(2);
    } else if (argument === '--publish-on-complete') options.publishOnComplete = true;
    else if (['--manifest', '--request-id'].includes(argument)) {
      const key = argument === '--manifest' ? 'manifestFile' : 'requestId';
      if (options[key] || !args[index + 1] || args[index + 1].startsWith('--')) fail('INVALID_ARGUMENTS', 'Falta el valor de la solicitud.');
      options[key] = args[++index];
    } else fail('INVALID_ARGUMENTS', 'Uso: node scripts/run-review-selection.js --check|--run|--publish|--status --request-id ID|--manifest /ruta/absoluta [--publish-on-complete]');
  }
  if (!options.mode || !!options.manifestFile === !!options.requestId || options.manifestFile && !path.isAbsolute(options.manifestFile)
    || options.requestId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(options.requestId)
    || options.publishOnComplete && options.mode !== 'run') fail('INVALID_ARGUMENTS', 'Indica un modo y una única solicitud válida.');
  return options;
}
async function privateJson(filename, value, exclusive = false) {
  if (exclusive) { await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); return; }
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, filename);
}
async function optionalJson(filename) { try { return JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function acquireLock(directory, id) {
  const filename = path.join(directory, 'worker.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(filename, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ id, pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })); await handle.close();
      return () => unlink(filename);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await optionalJson(filename);
      if (owner?.hostname !== os.hostname() || !Number.isInteger(owner.pid)) fail('REVIEW_WORKER_LOCKED', 'Existe otro bloqueo del trabajador.');
      try { process.kill(owner.pid, 0); fail('REVIEW_WORKER_LOCKED', 'El trabajador de esta solicitud sigue activo.'); }
      catch (check) { if (check.code !== 'ESRCH') throw check; }
      await unlink(filename);
    }
  }
  fail('REVIEW_WORKER_LOCKED', 'No se pudo adquirir el bloqueo del trabajador.');
}
async function loadManifest(base, options) {
  if (options.manifestFile) return validateFreshReviewManifest(JSON.parse(await readFile(options.manifestFile, 'utf8')));
  const [rows] = await base.pool.execute('SELECT payload FROM portal_settings WHERE id = ?', [`reviewRequest:${options.requestId}`]);
  if (rows.length !== 1) fail('REVIEW_REQUEST_NOT_FOUND', 'No se encontró la solicitud privada preparada.');
  const manifest = validateFreshReviewManifest(decode(rows[0].payload));
  if (manifest.id !== options.requestId) fail('INVALID_REVIEW_REQUEST', 'El identificador no coincide con el registro privado.');
  return manifest;
}
async function publish(base, store, manifest, progress, directory) {
  const ids = manifest.cases.map(item => item.conversationId);
  const [state, source] = await Promise.all([base.readNavigation(ids), store.reader.read({ fresh: true, conversationIds: ids })]);
  const selection = completedFreshReviewSelection(store.attach(state, source), manifest, progress);
  const connection = await base.pool.getConnection();
  try {
    await connection.beginTransaction(); await connection.query('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE');
    const [rows] = await connection.execute("SELECT payload FROM portal_settings WHERE id = 'reviewSelection' FOR UPDATE");
    const current = rows.length ? decode(rows[0].payload) : null;
    if (current?.id === selection.id && current?.selectionHash === selection.selectionHash) { await connection.rollback(); return { alreadyPublished: true, count: selection.caseCount }; }
    if ((current?.id || null) !== progress.previousSelection?.id || (current?.selectionHash || null) !== progress.previousSelection?.selectionHash) {
      fail('REVIEW_DEFAULT_CHANGED', 'La selección principal cambió mientras se evaluaba. No se reemplazó.');
    }
    const backup = path.join(directory, `reviewSelection-before-${Date.now()}.json`);
    await privateJson(backup, { backedUpAt: new Date().toISOString(), previous: current, nextId: selection.id, nextHash: selection.selectionHash }, true);
    await connection.execute("INSERT INTO portal_settings (id,payload) VALUES ('reviewSelection',?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)", [JSON.stringify(selection)]);
    await connection.commit();
    return { alreadyPublished: false, count: selection.caseCount, evaluationCount: selection.evaluationCount, selectionHash: selection.selectionHash };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
async function status(base, manifest, progress) {
  const planned = freshReviewChunks(manifest), keys = planned.map(chunk => chunk.idempotencyKey);
  const [jobs] = await base.pool.query(`SELECT id, JSON_UNQUOTE(JSON_EXTRACT(payload,'$.idempotencyKey')) requestKey,
    JSON_UNQUOTE(JSON_EXTRACT(payload,'$.status')) status, JSON_UNQUOTE(JSON_EXTRACT(payload,'$.updatedAt')) updatedAt
    FROM evaluation_jobs WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.idempotencyKey')) IN (${keys.map(() => '?').join(',')})`, keys);
  const ids = jobs.map(job => job.id);
  const rows = ids.length ? (await base.pool.query(`SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'$.profile.id')) profileId,
    JSON_UNQUOTE(JSON_EXTRACT(payload,'$.status')) status, COUNT(*) count
    FROM evaluation_tasks WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.jobId')) IN (${ids.map(() => '?').join(',')})
    GROUP BY profileId,status`, ids))[0] : [];
  return { event: 'status', requestId: manifest.id, cases: manifest.caseCount, expectedReviews: manifest.expectedNewEvaluations,
    status: progress?.status || 'prepared', published: !!progress?.publishedAt, errorCode: progress?.errorCode || null,
    jobs: jobs.map(({ id, status, updatedAt }) => ({ id, status, updatedAt })), models: manifest.profiles.map(profileId => ({ profileId,
      expected: manifest.caseCount, statuses: Object.fromEntries(rows.filter(row => row.profileId === profileId).map(row => [row.status, Number(row.count)])) })) };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseReviewArguments(args);
  if (config.demo || !databaseConfig() || !atomDatabaseConfig()) fail('REAL_MODE_REQUIRED', 'Configura las bases reales en el servidor de Pulso.');
  const base = new MysqlStore(databaseConfig()), reader = new AtomReader(atomDatabaseConfig(), config.timezone), store = new AtomHistoryStore(base, reader);
  let release, stateFilename;
  try {
    const manifest = await loadManifest(base, options);
    const directory = path.join(apiDirectory, '.data', 'review-runs', manifest.id), filename = path.join(directory, 'state.json');
    stateFilename = filename;
    let progress = await optionalJson(filename);
    if (options.mode === 'status') { log(await status(base, manifest, progress)); return; }
    const registry = registryFromEnv();
    if (options.mode === 'check') {
      const [state, source] = await Promise.all([base.evaluationWorker(`fresh-review-bootstrap:${manifest.id}`).read(), reader.read({ fresh: true, conversationIds: manifest.cases.map(item => item.conversationId) })]);
      assertFreshReviewSources(manifest, source.conversations);
      const configuration = freshReviewConfiguration(state, registry, manifest);
      log({ event: 'checked', readOnly: true, requestId: manifest.id, authorizedForExecution: manifest.authorizedForExecution === true && manifest.preparatoryOnly === false,
        cases: manifest.caseCount, reviews: manifest.expectedNewEvaluations, counts: manifest.counts, parts: freshReviewChunks(manifest).map(chunk => chunk.ids.length),
        selectionHash: manifest.selectionHash, deadline: manifest.reviewDeadline,
        expectedHashes: { catalogHash: configuration.catalogHash, runtimeHash: configuration.runtimeHash,
          modelProfiles: Object.fromEntries(configuration.profiles.map(profile => [profile.id, profile.configurationHash])) },
        models: configuration.profiles.map(({ id, model }) => ({ id, model })), runningJobs: state.jobs.filter(job => job.status === 'running').length });
      return;
    }
    validateFreshReviewManifest(manifest, { authorize: true });
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    release = await acquireLock(directory, manifest.id);
    progress = await optionalJson(filename);
    await privateJson(path.join(directory, 'request.json'), manifest);
    const checkpoint = async next => { progress = next; next.updatedAt = new Date().toISOString(); await privateJson(filename, next); };
    if (options.mode === 'run') {
      progress = await executeFreshReview({ store, registry, manifest, progress, checkpoint, report: log });
      log({ event: 'run_finished', requestId: manifest.id, status: progress.status, cases: manifest.caseCount,
        jobs: progress.chunks.map(({ index, jobId, status, models }) => ({ part: index, jobId, status, models })) });
      if (progress.status !== 'completed') { process.exitCode = 2; return; }
    }
    if (options.mode === 'publish' || options.publishOnComplete) {
      const publication = await publish(base, store, manifest, progress, directory);
      progress.publishedAt = new Date().toISOString(); await checkpoint(progress);
      log({ event: 'published', requestId: manifest.id, ...publication });
    }
  } catch (error) {
    if (release && stateFilename) {
      const latest = await optionalJson(stateFilename);
      if (latest) { latest.status = latest.status === 'completed' ? 'completed' : 'blocked'; latest.errorCode = safeCode(error); latest.updatedAt = new Date().toISOString(); await privateJson(stateFilename, latest); }
    }
    throw error;
  } finally { if (release) await release(); await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { log({ event: 'failed', code: safeCode(error) }); process.exitCode = 1; });
}
