import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { apiRoot, config, atomDatabaseConfig, databaseConfig } from '../src/config.js';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { AtomReader } from '../src/atom.js';
import { registryFromEnv } from '../src/model-registry.js';
import { eligibleConversations, runEvaluationBatch } from '../src/evaluation-service.js';
import { currentEvaluation, sourceFingerprint } from '../src/source-state.js';

if (!process.argv.includes('--execute') || process.env.OPENAI_EVALUATION_ENABLED !== 'true') throw new Error('Requiere --execute y OPENAI_EVALUATION_ENABLED=true.');
const base = new MysqlStore(databaseConfig());
const store = new AtomHistoryStore(base, new AtomReader(atomDatabaseConfig(), config.timezone));
const evaluator = registryFromEnv();
const directory = path.join(apiRoot, '.data', 'backfills');
let manifest, filename;
const persist = async () => { await writeFile(`${filename}.tmp`, JSON.stringify(manifest, null, 2), { mode: 0o600 }); await rename(`${filename}.tmp`, filename); };
const inspect = state => {
  const byId = new Map(state.conversations.map(c => [c.id, c]));
  const current = manifest.conversationIds.map(id => byId.get(id));
  const done = current.filter(c => c && currentEvaluation(state,c)?.sourceHash === sourceFingerprint(c));
  return { done, missing: current.filter(c => !c).length,
    pending: current.filter(c => c && !done.some(d=>d.id===c.id)) };
};
try {
  if (!evaluator.configured) throw new Error('Falta configurar el evaluador.');
  let state = await store.readWithConversations({ fresh: true });
  const maintenanceId = state.settings.evaluationMaintenance;
  if (!maintenanceId) throw new Error('No hay un reinicio pendiente. Este comando solo reanuda una renovación autorizada.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  filename = path.join(directory, `${maintenanceId}.json`);
  try { manifest = JSON.parse(await readFile(filename,'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    manifest = { id: maintenanceId, createdAt: new Date().toISOString(), status: 'running',
      conversationIds: eligibleConversations(state, { pendingOnly: false, includeOpen: true }).map(c=>c.id), jobs: [] };
    await persist();
  }
  console.log(JSON.stringify({ event: 'start', total: manifest.conversationIds.length, models: evaluator.list().map(p=>({id:p.id,model:p.model,available:p.available})), manifest: filename }));
  // A maximum of three passes; failed cases remain explicitly pending, never fabricated.
  for (let pass = 1; pass <= 3; pass++) {
    state = await store.readWithConversations({ fresh: true });
    const progress = inspect(state);
    if (!progress.pending.length) break;
    const pendingIds = progress.pending.map(c=>c.id);
    for (let offset = 0; offset < pendingIds.length; offset += 20) {
      const ids = pendingIds.slice(offset, offset + 20);
      const job = await runEvaluationBatch(store, evaluator, { conversationIds: ids, pendingOnly: true, max: 20, maintenanceId, concurrency: 3,
        onProgress: async ({ conversationId, error }) => {
          const latest = inspect(await store.readWithConversations());
          console.log(JSON.stringify({ event:'progress', conversationId, saved:latest.done.length, total:manifest.conversationIds.length, error: error ? 'No completada; revisar lote.' : null }));
        } });
      manifest.jobs.push(job.id); manifest.completed = inspect(await store.readWithConversations()).done.length; await persist();
      console.log(JSON.stringify({ event: 'batch', pass, jobId: job.id, completed: job.completed, failed: job.failed }));
      if (job.errors.some(e=>['AI_REJECTED','AI_CONFIGURATION','AI_SAFETY_REFUSAL'].includes(e.code))) throw new Error('El proveedor rechazó una evaluación. Se requiere intervención antes de continuar.');
    }
  }
  state = await store.readWithConversations({ fresh: true });
  const result = inspect(state);
  manifest.completed = result.done.length; manifest.missing = result.missing; manifest.pendingIds = result.pending.map(c=>c.id);
  manifest.status = result.done.length === manifest.conversationIds.length ? 'completed' : 'partial'; manifest.updatedAt = new Date().toISOString();
  await persist();
  if (manifest.status !== 'completed') throw new Error(`Quedan ${manifest.conversationIds.length - result.done.length} conversaciones pendientes. Reanuda este comando sin limpiar otra vez.`);
  await store.transaction(draft => {
    if (draft.settings.evaluationMaintenance !== maintenanceId) throw new Error('La configuración de renovación cambió.');
    draft.settings = { ...draft.settings, evaluationMaintenance: null, resetPreviousDailyEnabled: undefined,
      dailyEnabled: true, dailyStartedAt: draft.settings.dailyStartedAt || manifest.createdAt,
      includeOpenConversations: true, refreshChangedConversations: true,
      lastBackfillId: maintenanceId, lastBackfillCompletedAt: manifest.updatedAt, version: draft.settings.version + 1 };
  });
  console.log(JSON.stringify({ event: 'complete', evaluated: result.done.length, provisional: result.done.filter(c=>c.completed===false).length,
    dailyTime: state.settings.dailyTime, timezone: state.settings.timezone, manifest: filename }));
} catch (error) {
  if (manifest) { manifest.lastError = error.code || error.name; await persist(); }
  console.error(error.code || error.name, error.message); process.exitCode = 1;
} finally { await store.close(); }
