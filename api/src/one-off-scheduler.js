import { startEvaluationBatch, recoverEvaluationJobs, resumeEvaluationBatch } from './evaluation-service.js';
import { oneOffRuns, ingestionReadiness, selectOneOffConversations } from './one-off-evaluations.js';

async function updateRun(store, id, status, reason = null) {
  const current = oneOffRuns((await (store.readSchedulerState ? store.readSchedulerState() : store.read())).settings).find(r => r.id === id);
  if (!current || current.status === status && current.reason === reason) return;
  await store.transaction(state => {
    const run = oneOffRuns(state.settings).find(r => r.id === id);
    if (run) Object.assign(run, { status, reason, updatedAt: new Date().toISOString() });
  });
}
export async function runOneOffTick(store, evaluator, at = new Date(), operations = {}) {
  const start = operations.start || startEvaluationBatch, resume = operations.resume || resumeEvaluationBatch;
  await recoverEvaluationJobs(store);
  const state = await (store.readSchedulerState ? store.readSchedulerState() : store.read());
  for (const run of oneOffRuns(state.settings).filter(r => r.enabled)) {
    const job = state.jobs.find(j => j.oneOffRun?.id === run.id);
    if (job) {
      if (job.status === 'interrupted' && !state.jobs.some(j => j.status === 'running') && !state.settings.evaluationMaintenance && run.status !== 'blocked') {
        try {
          const execution = await resume(store, evaluator, job.id, { unfinishedOnly: true });
          execution.completion.catch(() => {});
          await updateRun(store, run.id, 'running');
          return true;
        } catch (error) { await updateRun(store, run.id, 'blocked', `No se pudo reanudar (${error.code || 'EVALUATION_FAILED'}). Revisa el estado de la corrida.`); return true; }
      }
      if (['completed', 'partial', 'failed', 'running'].includes(job.status)) await updateRun(store, run.id, job.status);
      continue;
    }
    if (at.toISOString() >= run.expiresAt) {
      await updateRun(store, run.id, 'not_started', run.reason || 'La jornada terminó antes de que pudiera iniciar.');
      continue;
    }
    if (at.toISOString() < run.notBefore) continue;
    if (state.settings.evaluationMaintenance || state.jobs.some(j => j.status === 'running')) {
      await updateRun(store, run.id, 'waiting_evaluation', state.settings.evaluationMaintenance ? 'El evaluador está en mantenimiento.' : 'Hay una evaluación en curso; se conserva su avance.');
      return true;
    }
    if (!store.readIngestionSnapshot) {
      await updateRun(store, run.id, 'waiting_ingestion', 'No se pudo verificar la carga del origen.'); return true;
    }
    const readiness = ingestionReadiness(await store.readIngestionSnapshot(run), run);
    if (!readiness.ready) {
      await updateRun(store, run.id, 'waiting_ingestion', readiness.missing.length ? `Falta una carga completa de: ${readiness.missing.join(', ')}.` : 'La ingesta tiene lotes en proceso o con errores.');
      return true;
    }
    const source = await store.readWithConversations({ fresh: true });
    const selected = selectOneOffConversations(source.conversations, run);
    if (run.countries.some(country => !selected.some(c => c.country === country))) {
      await updateRun(store, run.id, 'waiting_ingestion', 'Faltan conversaciones con contenido listo en alguno de los países.'); return true;
    }
    const options = { oneOffRun: { id: run.id, requestedAt: at.toISOString(), manifest: selected.map(c => ({ id: c.id, country: c.country, documentId: c.sourceDocumentId, batchId: c.ingestionBatchId })) },
      conversationIds: selected.map(c => c.id), modelIds: run.modelIds, max: selected.length, pendingOnly: false, includeOpen: true,
      executionOrder: 'model-first', concurrency: run.concurrency, idempotencyKey: `one-off:${run.id}` };
    try {
      const execution = await start(store, evaluator, options);
      execution.completion.catch(() => {});
      await updateRun(store, run.id, 'running');
    } catch (error) {
      if (['EVALUATION_RUNNING', 'DUPLICATE_EXECUTION'].includes(error.code)) await updateRun(store, run.id, 'waiting_evaluation', 'El evaluador está ocupado. Se verificará nuevamente.');
      else await updateRun(store, run.id, 'blocked', `No se pudo iniciar (${error.code || 'EVALUATION_FAILED'}). Revisa la carga y los modelos.`);
    }
    return true;
  }
  return false;
}
