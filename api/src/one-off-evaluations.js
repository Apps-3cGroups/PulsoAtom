import { AppError } from './errors.js';

export const fridayRun = Object.freeze({
  id: 'friday-2026-11-13-hn-pa', label: 'Corrida del viernes · HN y Panamá',
  timezone: 'America/Tegucigalpa', ingestionFrom: '2026-11-13T06:00:00.000Z',
  notBefore: '2026-11-13T16:30:00.000Z', expiresAt: '2026-11-14T06:00:00.000Z',
  countries: ['HN', 'PA'], modelIds: ['clef-local', 'gemma-local'], limitPerCountry: 200,
  concurrency: 2, enabled: true, status: 'scheduled',
});
export const oneOffRuns = settings => settings?.oneOffEvaluations || [];
export const inIngestionWindow = (conversation, run) => run.countries.includes(conversation.country)
  && conversation.ingestionBatchId && conversation.ingestionStartedAt >= run.ingestionFrom
  && conversation.ingestionStartedAt < run.expiresAt;
export function activeReason(conversation, settings, now = new Date()) {
  const at = now.toISOString();
  const exceptional = oneOffRuns(settings).find(run => run.enabled && at >= run.ingestionFrom && at < run.expiresAt && inIngestionWindow(conversation, run));
  if (exceptional) return { code: 'friday-cohort', label: 'Vigente por la jornada del viernes', expiresAt: exceptional.expiresAt, runId: exceptional.id };
  return !conversation.completed && !conversation.sourceClosedAt && ['ABIERTO', 'REASIGNADO', 'REINGRESO'].includes(conversation.sourceState)
    ? { code: 'source-open', label: 'En atención' } : null;
}
export function ingestionReadiness(snapshot, run) {
  const batches = snapshot.batches.filter(batch => !batch.countries.length || batch.countries.some(c => run.countries.includes(c)));
  const missing = run.countries.filter(country => !batches.some(batch => batch.countries.includes(country) && batch.status === 'LISTO'));
  const unfinished = batches.filter(batch => batch.status !== 'LISTO');
  return { ready: !missing.length && !unfinished.length, missing, unfinished: unfinished.map(b => b.id) };
}
export function selectOneOffConversations(conversations, run) {
  const counts = {};
  return conversations.filter(c => inIngestionWindow(c, run) && c.messages.length)
    .sort((a, b) => (b.activityAt || b.lastActivityAt || b.startedAt).localeCompare(a.activityAt || a.lastActivityAt || a.startedAt)
      || String(b.id).localeCompare(String(a.id), 'en', { numeric: true }))
    .filter(c => { if ((counts[c.country] || 0) >= run.limitPerCountry) return false; counts[c.country] = (counts[c.country] || 0) + 1; return true; });
}
export function validateOneOffRequest(state, options, candidates) {
  const request = options.oneOffRun;
  const run = oneOffRuns(state.settings).find(r => r.id === request?.id);
  const invalid = () => { throw new AppError(409, 'La corrida excepcional cambió o su selección no es válida.', 'ONE_OFF_CHANGED'); };
  const currentTime = (options.oneOffClock || (() => new Date()))().toISOString();
  if (run && currentTime >= run.expiresAt) throw new AppError(409, 'La jornada terminó antes de que pudiera iniciar.', 'ONE_OFF_EXPIRED');
  if (!run?.enabled || run.executionSupersededBy || !request.requestedAt || request.requestedAt < run.notBefore || request.requestedAt >= run.expiresAt
    || options.purpose && options.purpose !== 'operational' || options.dailyActivity || options.scheduleDate || options.largeBatch
    || options.pendingOnly !== false || options.includeOpen !== true || options.executionOrder !== 'model-first'
    || options.concurrency !== run.concurrency || JSON.stringify(options.modelIds) !== JSON.stringify(run.modelIds)
    || options.idempotencyKey !== `one-off:${run.id}` || !Array.isArray(options.conversationIds)
    || !options.conversationIds.length || options.max !== options.conversationIds.length
    || options.max > run.limitPerCountry * run.countries.length || !Array.isArray(request.manifest)
    || request.manifest.length !== options.conversationIds.length) invalid();
  const counts = {};
  for (const [index, item] of request.manifest.entries()) {
    if (item.id !== options.conversationIds[index] || !run.countries.includes(item.country)
      || !item.documentId || !item.batchId || (counts[item.country] = (counts[item.country] || 0) + 1) > run.limitPerCountry) invalid();
  }
  if (candidates && (candidates.length !== request.manifest.length || candidates.some((c, index) => {
    const item = request.manifest[index];
    return c.id !== item.id || c.country !== item.country || c.sourceDocumentId !== item.documentId
      || c.ingestionBatchId !== item.batchId || !inIngestionWindow(c, run);
  }))) invalid();
  return run;
}
export const runStatusLabel = run => ({
  scheduled: 'Programada para el viernes a las 10:30 a. m.', waiting_ingestion: 'Esperando carga',
  waiting_evaluation: 'Esperando que termine la evaluación en curso', running: 'Evaluación en curso',
  completed: 'Evaluación completada', partial: 'Evaluación finalizada con pendientes', failed: 'La evaluación requiere revisión',
  blocked: 'La corrida requiere revisión antes de continuar', not_started: 'La corrida no pudo iniciar durante la jornada',
  superseded: 'Sustituida por la carga completa del jueves',
}[run.status] || run.status);
export function publicOneOffRuns(state) {
  return oneOffRuns(state.settings).filter(run => run.enabled).map(run => {
    const job = state.jobs.find(j => j.oneOffRun?.id === run.id);
    const status = job && ['running', 'completed', 'partial', 'failed'].includes(job.status) ? job.status : run.status;
    return { id: run.id, label: run.label, status, statusLabel: runStatusLabel({ ...run, status }),
      notBefore: run.notBefore, expiresAt: run.expiresAt, reason: run.reason || null,
      jobId: job?.id || null, total: job?.total || 0, completed: job?.completed || 0,
      models: job?.modelProfiles?.map(p => ({ id: p.id, label: p.label })) || [] };
  });
}
