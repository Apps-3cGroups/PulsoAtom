import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { apiRoot, config, atomDatabaseConfig, databaseConfig } from '../src/config.js';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { AtomReader } from '../src/atom.js';
import { registryFromEnv } from '../src/model-registry.js';
import { AppError } from '../src/errors.js';
import { createGemmaBackfillPlan, gemmaBackfillProfile, inspectGemmaBackfill, executeGemmaBackfill,
  persistBackfillManifest, acquireBackfillLock, readRequiredBackfillManifest } from '../src/gemma-backfill.js';

// Default and --plan are read-only. Reset/backup is a separate explicit command.
function argumentsFor(args) {
  let mode = 'plan', explicitMode = false, maintenanceId = null, resume = false, maxBatches = Infinity;
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (['--plan', '--dry-run', '--execute', '--status'].includes(argument)) {
      if (explicitMode) throw new AppError(422, 'Selecciona solo --plan, --status o --execute.', 'INVALID_ARGUMENTS');
      explicitMode = true; mode = argument === '--execute' ? 'execute' : argument === '--status' ? 'status' : 'plan';
    } else if (argument === '--maintenance-id') maintenanceId = args[++i];
    else if (argument === '--resume') resume = true;
    else if (argument === '--max-batches') {
      const value = args[++i];
      if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 10000) throw new AppError(422, '--max-batches debe estar entre 1 y 10000.', 'INVALID_ARGUMENTS');
      maxBatches = Number(value);
    } else throw new AppError(422, 'Argumento no admitido. Usa --plan o --execute --maintenance-id ID [--resume] [--max-batches N].', 'INVALID_ARGUMENTS');
  }
  if (maintenanceId != null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(maintenanceId)) throw new AppError(422, 'El mantenimiento debe ser un UUID válido.', 'INVALID_ARGUMENTS');
  if (mode !== 'plan' && !maintenanceId) throw new AppError(422, 'Indica el ID del mantenimiento respaldado con --maintenance-id.', 'INVALID_ARGUMENTS');
  if (mode !== 'execute' && (resume || maxBatches !== Infinity)) throw new AppError(422, '--resume y --max-batches requieren --execute.', 'INVALID_ARGUMENTS');
  return { mode, maintenanceId, resume, maxBatches };
}

let store, manifest, filename, release;
const summaryOnly = summary => { const { cases, ...counts } = summary; return counts; };
try {
  const options = argumentsFor(process.argv.slice(2));
  const db = databaseConfig(), atom = atomDatabaseConfig();
  if (config.demo || !db || !atom) throw new AppError(409, 'Configura Pulso real y la lectura de Atom antes de preparar la renovación.', 'INTEGRATION_PENDING');
  store = new AtomHistoryStore(new MysqlStore(db), new AtomReader(atom, config.timezone));
  const registry = registryFromEnv();
  const settingsState = await store.read();
  if (options.mode !== 'status') gemmaBackfillProfile(settingsState, registry);
  const directory = path.join(apiRoot, '.data', 'backfills');
  if (options.mode === 'plan') {
    const state = await store.readWithConversations({ fresh: true });
    const plan = createGemmaBackfillPlan(state, registry, { maintenanceId: options.maintenanceId });
    console.log(JSON.stringify({ event: 'plan', readOnly: true, total: plan.conversations.length,
      open: plan.conversations.filter(c => !c.completedAtSource).length,
      closed: plan.conversations.filter(c => c.completedAtSource).length, profile: plan.profile,
      catalogHash: plan.conversations[0].catalogHash, promptHash: plan.conversations[0].promptHash,
      rulesVersion: plan.conversations[0].rulesVersion, dailyEnabled: state.settings.dailyEnabled,
      maintenanceActive: !!state.settings.evaluationMaintenance, runningJobs: state.jobs.filter(j => ['running', 'queued', 'pending'].includes(j.status)).length,
      existingEvaluations: state.evaluations.length, maxRounds: 3, concurrency: 1, batchSize: 20,
      note: 'No se creó un manifiesto ni se ejecutó IA. El respaldo y reinicio son acciones separadas.' }, null, 2));
  } else {
    filename = path.join(directory, `${options.maintenanceId}.json`);
    if (options.mode === 'execute') {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      release = await acquireBackfillLock(`${filename}.lock`, options.maintenanceId);
    }
    manifest = await readRequiredBackfillManifest(filename);
    if (options.mode === 'status') {
      const state = await store.readWithConversations({ fresh: true });
      console.log(JSON.stringify({ event: 'status', readOnly: true, manifest: filename,
        ...summaryOnly(inspectGemmaBackfill(state, manifest)), savedStatus: manifest.status,
        dailyEnabled: state.settings.dailyEnabled, maintenanceActive: state.settings.evaluationMaintenance === manifest.id }, null, 2));
    } else {
      console.log(JSON.stringify({ event: 'start', manifest: filename, total: manifest.conversations.length, profile: manifest.profile, resume: options.resume }));
      const summary = await executeGemmaBackfill(store, registry, manifest, { resume: options.resume, maxBatches: options.maxBatches,
        checkpoint: current => persistBackfillManifest(filename, current),
        onProgress: progress => console.log(JSON.stringify({ event: 'progress', ...progress })) });
      console.log(JSON.stringify({ event: summary.status === 'completed' ? 'complete' : 'pending', manifest: filename, ...summaryOnly(summary) }));
      if (summary.pending) process.exitCode = 2;
    }
  }
} catch (error) {
  if (manifest && release) {
    manifest.lastError = error instanceof AppError ? error.code : 'BACKFILL_FAILED';
    manifest.status = 'blocked'; manifest.updatedAt = new Date().toISOString();
    try { await persistBackfillManifest(filename, manifest); } catch { console.error('No se pudo actualizar el checkpoint. Conserva el manifiesto y revisa el almacenamiento.'); }
  }
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : 'No se pudo completar la renovación. Revisa conexión y almacenamiento; no se muestran datos privados.');
  process.exitCode = 1;
} finally {
  try { if (release) await release(); }
  catch { console.error('No se pudo retirar el bloqueo local; verifica que el proceso terminó antes de retirarlo manualmente.'); process.exitCode = 1; }
  await store?.close();
}
