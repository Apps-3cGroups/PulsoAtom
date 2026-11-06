import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../src/errors.js';
import { catalogAvailability } from '../src/catalog-presentation.js';
import { createGemmaBackfillPlan, gemmaBackfillProfile, normalizeGemmaSelection, persistBackfillManifest, acquireBackfillLock } from '../src/gemma-backfill.js';

const executeFile = promisify(execFile);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const fail = (code, message) => { throw new AppError(409, message, code); };
const live = job => ['running', 'queued', 'pending'].includes(job.status);
const codeFiles = ['scripts/start-gemma-renewal.js', 'scripts/reset-evaluations.js', 'scripts/evaluate-all.js',
  'src/gemma-backfill.js', 'src/evaluation-service.js', 'src/evaluator.js', 'src/gateway-evaluator.js', 'src/evaluation-reset-safety.js'];

export function parseGemmaRenewalArguments(args) {
  const keys = new Map([
    ['--expected-evaluations', 'evaluations'], ['--expected-policy-version', 'policyVersion'],
    ['--expected-configuration-hash', 'configurationHash'], ['--expected-catalog-hash', 'catalogHash'],
    ['--expected-prompt-hash', 'promptHash'], ['--maintenance-id', 'maintenanceId'],
    ['--from', 'from'], ['--to', 'to'], ['--limit', 'limit'],
  ]);
  let mode;
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--start', '--status', '--help'].includes(argument)) {
      if (mode) fail('INVALID_ARGUMENTS', 'Selecciona un único modo: --start, --status o --help.');
      mode = argument.slice(2); continue;
    }
    const key = keys.get(argument), value = args[++index];
    if (!key || key in values || value === undefined || value.startsWith('--')) fail('INVALID_ARGUMENTS', 'Los argumentos de renovación son inválidos. Consulta --help.');
    values[key] = value;
  }
  if (mode === 'help' && !Object.keys(values).length) return { mode };
  if (mode === 'status' && Object.keys(values).length === 1 && uuid.test(values.maintenanceId || '')) return { mode, maintenanceId: values.maintenanceId };
  if (mode !== 'start' || Object.keys(values).length !== 8 || 'maintenanceId' in values
    || !/^\d+$/.test(values.evaluations || '') || !/^\d+$/.test(values.policyVersion || '')
    || !Number.isSafeInteger(Number(values.evaluations)) || !Number.isSafeInteger(Number(values.policyVersion)) || Number(values.policyVersion) < 1
    || !['configurationHash', 'catalogHash', 'promptHash'].every(key => hash.test(values[key] || ''))) {
    fail('INVALID_ARGUMENTS', 'Indica --start con el rango, límite, conteo, versión de política y las tres huellas validadas.');
  }
  const { from, to, limit, ...expected } = values;
  if (!/^\d+$/.test(limit || '')) fail('INVALID_ARGUMENTS', 'El límite debe ser un entero entre 1 y 100.');
  const selection = normalizeGemmaSelection({ from, to, limit: Number(limit), timezone: 'America/Tegucigalpa', basis: 'last_activity' });
  return { mode, selection, expected: { ...expected, evaluations: Number(values.evaluations), policyVersion: Number(values.policyVersion) } };
}

function assertStartState(state, registry, expected, plan) {
  const { profile, policyVersion } = gemmaBackfillProfile(state, registry);
  const active = state.catalog.filter(variable => variable.active);
  if (!active.length || active.some(variable => !catalogAvailability(variable).canActivate)) fail('UNSUPPORTED_VARIABLE', 'El checklist activo incluye variables no implementadas o no tiene variables habilitadas. No se modifica el histórico.');
  if (state.settings.evaluationMaintenance) fail('EVALUATION_MAINTENANCE', 'Ya existe un mantenimiento. Consulta su estado; no se volverá a limpiar.');
  if (state.settings.dailyEnabled !== false) fail('DAILY_MUST_BE_PAUSED', 'Pausa la programación antes de iniciar la renovación.');
  if (state.jobs.some(live)) fail('EVALUATION_RUNNING', 'Hay una ejecución activa o en cola. No se modifica el histórico.');
  if (state.evaluations.length !== expected.evaluations) fail('EVALUATION_COUNT_CHANGED', 'Cambió el total de evaluaciones auditado. No se modifica el histórico.');
  if (policyVersion !== expected.policyVersion || profile.configurationHash !== expected.configurationHash) fail('MODEL_CHANGED', 'La política o configuración ya no coincide con la comprobación aprobada.');
  if (plan.conversations.some(c => c.catalogHash !== expected.catalogHash || c.promptHash !== expected.promptHash)) fail('CONTRACT_CHANGED', 'El catálogo o las instrucciones ya no coinciden con la comprobación aprobada.');
}

async function sha256File(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}
async function codeHashes(apiDirectory) {
  return Object.fromEntries(await Promise.all(codeFiles.map(async filename => [filename, await sha256File(path.join(apiDirectory, filename))])));
}

async function resetEvaluations({ apiDirectory, expected, env }) {
  const args = [path.join(apiDirectory, 'scripts/reset-evaluations.js'), '--apply',
    '--expected-evaluations', String(expected.evaluations), '--expected-policy-version', String(expected.policyVersion),
    '--expected-configuration-hash', expected.configurationHash, '--expected-catalog-hash', expected.catalogHash,
    '--expected-prompt-hash', expected.promptHash];
  try {
    const result = await executeFile(process.execPath, args, { cwd: apiDirectory, env, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout);
  } catch { fail('RESET_FAILED', 'No se confirmó el reinicio respaldado. Consulta el mantenimiento antes de volver a intentar; no se inició IA.'); }
}

async function verifyReset(result, apiDirectory, databaseName, expected) {
  const directory = path.join(apiDirectory, '.data/backups');
  if (!result || result.reset !== true || !uuid.test(result.maintenanceId || '') || !hash.test(result.sha256 || '')
    || result.database !== databaseName || result.archivedCounts?.evaluations !== expected.evaluations
    || typeof result.backup !== 'string' || path.dirname(path.resolve(result.backup)) !== directory
    || !/^evaluations-[A-Za-z0-9-]+\.json$/.test(path.basename(result.backup))) {
    fail('RESET_NOT_CONFIRMED', 'La respuesta del reinicio no coincide con la operación. No se inició IA.');
  }
  const checksum = (await readFile(`${result.backup}.sha256`, 'utf8')).trim();
  if (checksum !== result.sha256 || await sha256File(result.backup) !== result.sha256) fail('BACKUP_NOT_VERIFIED', 'El respaldo no coincide con su huella. No se inició IA.');
}

async function launchBackfill({ apiDirectory, maintenanceId, logFile, env }) {
  const log = await open(logFile, 'wx', 0o600);
  try {
    const child = spawn(process.execPath, [path.join(apiDirectory, 'scripts/evaluate-all.js'), '--execute', '--maintenance-id', maintenanceId],
      { cwd: apiDirectory, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || pid < 1) fail('WORKER_NOT_STARTED', 'No se confirmó el proceso de renovación. El mantenimiento continúa activo.');
    child.unref();
    return { pid };
  } finally { await log.close(); }
}

// Destructive work is isolated to the existing reset command; its own lock
// rechecks the expected count, policy and contract before any DELETE.
export async function startGemmaRenewal({ store, registry, expected, selection, apiDirectory, databaseName,
  env = process.env, reset = resetEvaluations, launch = launchBackfill }) {
  const scope = normalizeGemmaSelection(selection);
  const directory = path.join(apiDirectory, '.data/backfills');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const operationId = randomUUID(), release = await acquireBackfillLock(path.join(directory, 'renewal-start.lock'), operationId);
  let operation, journal;
  try {
    const state = await store.readWithConversations({ fresh: true });
    const plan = createGemmaBackfillPlan(state, registry, { selection: scope });
    assertStartState(state, registry, expected, plan);
    journal = path.join(directory, `renewal-start-${operationId}.json`);
    const preparedManifestFile = path.join(directory, `renewal-start-${operationId}.manifest.json`);
    await persistBackfillManifest(preparedManifestFile, plan);
    operation = { format: 1, operationId, status: 'prepared', createdAt: new Date().toISOString(), expected,
      total: plan.conversations.length, selection: scope, profileId: plan.profile.id, preparedManifestFile, codeHashes: await codeHashes(apiDirectory) };
    await persistBackfillManifest(journal, operation);
    const result = await reset({ apiDirectory, expected, env });
    await verifyReset(result, apiDirectory, databaseName, expected);
    Object.assign(operation, { status: 'reset_complete', maintenanceId: result.maintenanceId,
      backup: result.backup, backupSha256: result.sha256, archivedEvaluations: expected.evaluations });
    await persistBackfillManifest(journal, operation);
    // Freeze the source read BEFORE the reset, not a new universe fetched later.
    const manifest = createGemmaBackfillPlan(state, registry, { maintenanceId: result.maintenanceId, createdAt: plan.createdAt, selection: scope });
    const manifestFile = path.join(directory, `${result.maintenanceId}.json`);
    const operationFile = path.join(directory, `${result.maintenanceId}.operation.json`);
    const logFile = path.join(directory, `${result.maintenanceId}.log`);
    await persistBackfillManifest(manifestFile, manifest);
    Object.assign(operation, { status: 'starting', manifestFile, logFile });
    await persistBackfillManifest(operationFile, operation);
    const child = await launch({ apiDirectory, maintenanceId: result.maintenanceId, logFile, env });
    if (!Number.isSafeInteger(child?.pid) || child.pid < 1) fail('WORKER_NOT_STARTED', 'No se confirmó el proceso de renovación. El mantenimiento continúa activo.');
    Object.assign(operation, { status: 'started', pid: child.pid, startedAt: new Date().toISOString() });
    await persistBackfillManifest(operationFile, operation);
    await persistBackfillManifest(journal, operation);
    return { started: true, maintenanceId: result.maintenanceId, pid: child.pid, total: manifest.conversations.length, selection: scope,
      backup: result.backup, backupSha256: result.sha256, manifestFile, operationFile, logFile,
      dailyEnabled: false, note: 'Se inició el trabajador. La finalización debe comprobarse con --status.' };
  } catch (error) {
    if (operation && journal) {
      operation.status = 'blocked'; operation.updatedAt = new Date().toISOString();
      operation.error = error instanceof AppError ? error.code : 'RENEWAL_START_FAILED';
      await persistBackfillManifest(journal, operation).catch(() => {});
      if (operation.maintenanceId) await persistBackfillManifest(path.join(directory, `${operation.maintenanceId}.operation.json`), operation).catch(() => {});
    }
    throw error;
  } finally { await release(); }
}

export async function gemmaRenewalStatus({ store, apiDirectory, maintenanceId }) {
  if (!uuid.test(maintenanceId || '')) fail('INVALID_ARGUMENTS', 'Indica un ID de mantenimiento válido.');
  const directory = path.join(apiDirectory, '.data/backfills');
  const [state, operation, manifest] = await Promise.all([store.read(),
    readFile(path.join(directory, `${maintenanceId}.operation.json`), 'utf8').then(JSON.parse),
    readFile(path.join(directory, `${maintenanceId}.json`), 'utf8').then(JSON.parse)]);
  if (operation.maintenanceId !== maintenanceId || manifest.id !== maintenanceId) fail('MANIFEST_MISMATCH', 'Los archivos no corresponden al mantenimiento solicitado.');
  const jobs = state.jobs.filter(job => job.maintenanceId === maintenanceId), jobIds = new Set(jobs.map(job => job.id));
  const tasks = state.tasks.filter(task => jobIds.has(task.jobId));
  return { readOnly: true, maintenanceId, workerPid: operation.pid || null, operationStatus: operation.status,
    manifestStatus: manifest.status, total: manifest.conversations.length, selection: manifest.selection,
    lastCheckpoint: manifest.updatedAt, checkpointCompleted: manifest.summary?.completed ?? 0,
    checkpointPending: manifest.summary?.pending ?? manifest.conversations.length,
    runningJobs: jobs.filter(live).length, completedTasks: tasks.filter(t => t.status === 'completed').length,
    partialTasks: tasks.filter(t => t.status === 'partial').length, failedTasks: tasks.filter(t => t.status === 'failed').length,
    maintenanceActive: state.settings.evaluationMaintenance === maintenanceId, dailyEnabled: state.settings.dailyEnabled === true,
    backup: operation.backup, backupSha256: operation.backupSha256, logFile: operation.logFile };
}

async function main(args) {
  const options = parseGemmaRenewalArguments(args);
  if (options.mode === 'help') {
    console.log('Inicio autorizado: --start --from YYYY-MM-DD --to YYYY-MM-DD --limit N --expected-evaluations N --expected-policy-version N --expected-configuration-hash HEX --expected-catalog-hash HEX --expected-prompt-hash HEX\nEstado de solo lectura: --status --maintenance-id UUID\nEl inicio exige Gemma individual y programación pausada. Respalda y limpia todas las evaluaciones; evalúa únicamente la selección del rango por última actividad en Tegucigalpa (máximo 100). No reactiva la programación diaria ni reanuda automáticamente.');
    return;
  }
  const { apiRoot, config, databaseConfig, atomDatabaseConfig } = await import('../src/config.js');
  const { MysqlStore, AtomHistoryStore } = await import('../src/store.js');
  const { AtomReader } = await import('../src/atom.js');
  const { registryFromEnv } = await import('../src/model-registry.js');
  const db = databaseConfig();
  if (config.demo || !db) fail('REAL_MODE_REQUIRED', 'Configura la base real de Pulso antes de continuar.');
  const atom = options.mode === 'start' ? atomDatabaseConfig() : null;
  if (options.mode === 'start' && !atom) fail('INTEGRATION_PENDING', 'Falta configurar la lectura de Atom.');
  const store = atom ? new AtomHistoryStore(new MysqlStore(db), new AtomReader(atom, config.timezone)) : new MysqlStore(db);
  try {
    const result = options.mode === 'start' ? await startGemmaRenewal({ store, registry: registryFromEnv(), expected: options.expected, selection: options.selection,
      apiDirectory: apiRoot, databaseName: db.database }) : await gemmaRenewalStatus({ store, apiDirectory: apiRoot, maintenanceId: options.maintenanceId });
    console.log(JSON.stringify(result, null, 2));
  } finally { await store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof AppError ? `${error.code}: ${error.message}` : 'No se pudo completar la operación. Consulta el mantenimiento y los archivos privados; no se muestran datos del proveedor ni de la base.');
    process.exitCode = 1;
  });
}
