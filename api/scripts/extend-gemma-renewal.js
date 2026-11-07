import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { AppError } from '../src/errors.js';
import { acquireBackfillLock, extendGemmaBackfillPlan, normalizeGemmaSelection, persistBackfillManifest } from '../src/gemma-backfill.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = (code, message) => { throw new AppError(409, message, code); };
export function parseGemmaExtensionArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args[0] !== '--extend') fail('INVALID_ARGUMENTS', 'Usa --extend con el mantenimiento, total esperado, período y nuevo límite.');
  const allowed = new Map([['--maintenance-id', 'maintenanceId'], ['--expected-total', 'expectedTotal'], ['--from', 'from'], ['--to', 'to'], ['--limit', 'limit']]);
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const key = allowed.get(args[index]), value = args[index + 1];
    if (!key || key in values || value === undefined || value.startsWith('--')) fail('INVALID_ARGUMENTS', 'Argumentos inválidos para la ampliación.');
    values[key] = value;
  }
  if (Object.keys(values).length !== 5 || !uuid.test(values.maintenanceId || '') || !/^\d+$/.test(values.expectedTotal || '')
    || !Number.isSafeInteger(Number(values.expectedTotal)) || Number(values.expectedTotal) < 1 || !/^\d+$/.test(values.limit || '')) fail('INVALID_ARGUMENTS', 'Indica un mantenimiento y total esperado válidos.');
  return { maintenanceId: values.maintenanceId, expectedTotal: Number(values.expectedTotal), selection: normalizeGemmaSelection({
    from: values.from, to: values.to, limit: Number(values.limit), timezone: 'America/Tegucigalpa', basis: 'last_activity' }) };
}

async function archiveManifest(filename, text) {
  let handle;
  try { handle = await open(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST' || await readFile(filename, 'utf8') !== text) throw error;
    return;
  }
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  const directory = await open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function launchWorker({ apiDirectory, maintenanceId, logFile, env }) {
  const log = await open(logFile, 'wx', 0o600);
  try {
    const worker = spawn(process.execPath, [path.join(apiDirectory, 'scripts/evaluate-all.js'), '--execute', '--resume', '--maintenance-id', maintenanceId],
      { cwd: apiDirectory, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); });
    worker.unref(); return { pid: worker.pid };
  } finally { await log.close(); }
}

// No reset command and no direct database writes. The existing worker appends
// results after this command durably publishes the authorized successor scope.
export async function extendGemmaRenewal({ store, registry, apiDirectory, maintenanceId, expectedTotal, selection,
  env = process.env, launch = launchWorker }) {
  if (!uuid.test(maintenanceId || '')) fail('INVALID_ARGUMENTS', 'El mantenimiento no es válido.');
  const scope = normalizeGemmaSelection(selection);
  const directory = path.join(apiDirectory, '.data/backfills'), manifestFile = path.join(directory, `${maintenanceId}.json`);
  const operationFile = path.join(directory, `${maintenanceId}.operation.json`);
  let release = await acquireBackfillLock(`${manifestFile}.lock`, maintenanceId), operation, changed = false;
  try {
    const [text, operationText, state] = await Promise.all([readFile(manifestFile, 'utf8'), readFile(operationFile, 'utf8'), store.readWithConversations({ fresh: true })]);
    const manifest = JSON.parse(text); operation = JSON.parse(operationText);
    if (manifest.id !== maintenanceId || operation.maintenanceId !== maintenanceId) fail('MANIFEST_MISMATCH', 'El manifiesto y la operación no corresponden al mantenimiento.');
    if (operation.extension?.status === 'starting') fail('EXTENSION_STARTING', 'Hay un arranque de ampliación pendiente de confirmar. Revisa su estado antes de continuar.');
    const next = extendGemmaBackfillPlan(state, registry, manifest, { expectedTotal, selection: scope });
    const archive = path.join(directory, `${maintenanceId}.revision-${manifest.revision?.number || 1}-${manifest.integrityHash}.json`);
    await archiveManifest(archive, text);
    const archiveSha256 = createHash('sha256').update(text).digest('hex');
    const logFile = path.join(directory, `${maintenanceId}.revision-${next.revision.number}-${Date.now()}.log`);
    operation.extension = { status: 'prepared', previousTotal: expectedTotal, total: next.conversations.length,
      parentIntegrityHash: manifest.integrityHash, integrityHash: next.integrityHash, archive, archiveSha256, createdAt: next.revision.extendedAt };
    changed = true;
    await persistBackfillManifest(operationFile, operation);
    await persistBackfillManifest(manifestFile, next);
    Object.assign(operation, { status: 'starting', total: next.conversations.length, selection: scope, logFile,
      previousWorkerPid: operation.pid || null, pid: null });
    operation.extension.status = 'starting';
    await persistBackfillManifest(operationFile, operation);
    // evaluate-all acquires the same lock. Publish its reservation first and
    // release the parent lock before spawning; concurrent extensions see starting.
    await release(); release = null;
    const child = await launch({ apiDirectory, maintenanceId, logFile, env });
    if (!Number.isSafeInteger(child?.pid) || child.pid < 1) fail('WORKER_NOT_STARTED', 'No se confirmó el trabajador. Conserva el manifiesto y reanuda explícitamente.');
    Object.assign(operation, { status: 'started', pid: child.pid, startedAt: new Date().toISOString() });
    operation.extension.status = 'started';
    await persistBackfillManifest(operationFile, operation);
    return { started: true, destructive: false, maintenanceId, previousTotal: expectedTotal, total: next.conversations.length,
      added: next.conversations.length - expectedTotal, reusedCompleted: next.revision.reusedCompleted, retainedPending: next.revision.retainedPending,
      selectedActivityFrom: next.conversations.map(c => c.activityDate).filter(Boolean).sort()[0],
      selectedActivityTo: next.conversations.map(c => c.activityDate).filter(Boolean).sort().at(-1),
      activityAsOf: next.revision.activityAsOf, selection: scope, pid: child.pid, logFile, manifestFile,
      archive, archiveSha256, integrityHash: next.integrityHash, dailyEnabled: false,
      note: 'Se conservan evaluaciones, tareas y límites de reintento anteriores. El trabajador continúa solo los casos pendientes.' };
  } catch (error) {
    if (changed && operation) {
      operation.status = 'blocked'; operation.extension.status = 'failed';
      operation.extension.error = error instanceof AppError ? error.code : 'EXTENSION_FAILED';
      await persistBackfillManifest(operationFile, operation).catch(() => {});
    }
    throw error;
  } finally { if (release) await release(); }
}

async function main(args) {
  const options = parseGemmaExtensionArguments(args);
  if (options.help) {
    console.log('Uso: --extend --maintenance-id UUID --expected-total N --from YYYY-MM-DD --to YYYY-MM-DD --limit N\nAmplía hasta 500 conversaciones por última actividad sin borrar evaluaciones; el período debe incluir el anterior. Conserva la programación pausada y Gemma como único modelo.'); return;
  }
  const { apiRoot, config, databaseConfig, atomDatabaseConfig } = await import('../src/config.js');
  const { MysqlStore, AtomHistoryStore } = await import('../src/store.js');
  const { AtomReader } = await import('../src/atom.js');
  const { registryFromEnv } = await import('../src/model-registry.js');
  const db = databaseConfig(), atom = atomDatabaseConfig();
  if (config.demo || !db || !atom) fail('REAL_MODE_REQUIRED', 'Configura Pulso y Atom reales antes de ampliar.');
  const store = new AtomHistoryStore(new MysqlStore(db), new AtomReader(atom, config.timezone));
  try { console.log(JSON.stringify(await extendGemmaRenewal({ store, registry: registryFromEnv(), apiDirectory: apiRoot, ...options }), null, 2)); }
  finally { await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof AppError ? `${error.code}: ${error.message}` : 'No se pudo ampliar la muestra. Consulta el mantenimiento; no se borraron evaluaciones.');
    process.exitCode = 1;
  });
}
