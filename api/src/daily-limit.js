import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { DAILY_ACTIVITY_MODE, dailyActivityRequest, previousDate } from './daily-activity.js';
import { scheduleClock } from './daily-scheduler.js';

const terminal = status => ['completed', 'partial', 'failed'].includes(status);
const targetJobs = (state, date) => state.jobs.filter(j => j.dailyActivity?.date === date && j.dailyActivity.timezone === 'America/Tegucigalpa');
function verifySettings(settings) {
  if (!settings.dailyEnabled || settings.dailyMode !== DAILY_ACTIVITY_MODE || settings.timezone !== 'America/Tegucigalpa'
    || JSON.stringify(settings.dailyCountries) !== JSON.stringify(['HN', 'PA'])
    || JSON.stringify(settings.dailyModelIds) !== JSON.stringify(['clef-local', 'gemma-local'])) {
    throw new AppError(409, 'El ajuste requiere la programación HN/PA con Clef y Gemma.', 'SCHEDULE_CHANGED');
  }
}

// Preparation blocks new jobs, but lets the current model request finish until
// deployment stops the old worker. No result or task is changed in this step.
export async function prepareDailyLimit(store, { activityDate, expectedVersion, limitPerCountry = 200, concurrency = 2, now = new Date() }) {
  const runDate = scheduleClock(now, 'America/Tegucigalpa').date;
  if (activityDate !== previousDate(runDate)) throw new AppError(422, 'La fecha debe ser ayer en Honduras.', 'INVALID_ACTIVITY_DATE');
  if (!Number.isInteger(limitPerCountry) || limitPerCountry < 1 || limitPerCountry > 1000
    || ![1, 2].includes(concurrency)) throw new AppError(422, 'Límite o concurrencia inválidos.', 'INVALID_DAILY_LIMIT');
  const source = await store.readWithConversations({ fresh: true });
  const countries = Object.fromEntries(source.conversations.map(c => [c.id, c.country]));
  return store.transaction(state => {
    verifySettings(state.settings);
    if (state.settings.version !== expectedVersion) throw new AppError(409, 'La configuración cambió.', 'VERSION_CONFLICT');
    if (state.settings.evaluationMaintenance) throw new AppError(409, 'Hay otro mantenimiento activo.', 'EVALUATION_MAINTENANCE');
    const jobs = targetJobs(state, activityDate);
    const conversationCountries = {};
    for (const job of jobs) {
      if (JSON.stringify(job.modelProfiles.map(p => p.id)) !== JSON.stringify(state.settings.dailyModelIds)) throw new AppError(409, 'La cohorte usa otros modelos.', 'MODEL_CHANGED');
      for (const id of job.conversationIds) {
        const country = job.conversationCountries?.[id] || countries[id];
        if (!['HN', 'PA'].includes(country)) throw new AppError(409, 'No se pudo verificar el país de la cohorte.', 'DAILY_COUNTRY_UNKNOWN');
        conversationCountries[id] = country;
      }
    }
    const request = { id: randomUUID(), activityDate, runDate, limitPerCountry, concurrency,
      conversationCountries, jobIds: jobs.map(j => j.id), preparedAt: now.toISOString() };
    state.settings = { ...state.settings, evaluationMaintenance: request.id, dailyLimitChange: request,
      version: state.settings.version + 1, updatedAt: now.toISOString(), updatedBy: 'Límite diario solicitado por Mario Cruz' };
    return { id: request.id, settingsVersion: state.settings.version, activityDate, limitPerCountry, concurrency };
  });
}

// Apply only after the previous worker's lease has expired. Using the shared
// transaction lock makes the cap, deferred tasks and scheduler release atomic.
export async function applyDailyLimit(store, { requestId, expectedVersion, now = new Date() }) {
  return store.transaction(state => {
    const settings = state.settings, request = settings.dailyLimitChange;
    verifySettings(settings);
    if (settings.version !== expectedVersion) throw new AppError(409, 'La configuración cambió.', 'VERSION_CONFLICT');
    if (!request || request.id !== requestId || settings.evaluationMaintenance !== requestId) throw new AppError(409, 'El ajuste pendiente no coincide.', 'EVALUATION_MAINTENANCE');
    if (state.jobs.some(j => j.status === 'running' && Date.parse(j.updatedAt || j.createdAt) >= now.getTime() - 10 * 60_000)) {
      throw new AppError(409, 'El evaluador anterior aún tiene una señal de actividad vigente.', 'EVALUATION_RUNNING');
    }
    if (state.jobs.some(j => j.status === 'running' && !request.jobIds.includes(j.id))) throw new AppError(409, 'Existe otro lote interrumpido fuera del ajuste.', 'EVALUATION_RUNNING');
    const jobs = targetJobs(state, request.activityDate).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (jobs.some(j => !request.jobIds.includes(j.id))) throw new AppError(409, 'Se agregaron lotes después de preparar el ajuste.', 'SCHEDULE_CHANGED');
    const allIds = [...new Set(jobs.flatMap(j => j.conversationIds))];
    const jobIds = new Set(jobs.map(j => j.id));
    const protectedIds = new Set([
      ...state.tasks.filter(t => jobIds.has(t.jobId) && !['pending', 'deferred'].includes(t.status)).map(t => t.conversationId),
      ...state.attempts.filter(a => jobIds.has(a.jobId)).map(a => state.tasks.find(t => t.id === a.taskId)?.conversationId),
      ...state.evaluations.filter(e => jobIds.has(e.jobId)).map(e => e.conversationId),
      ...jobs.filter(j => terminal(j.status)).flatMap(j => j.conversationIds),
    ]);
    const counts = { HN: 0, PA: 0 }, selected = new Set();
    for (const id of [...allIds.filter(id => protectedIds.has(id)), ...allIds.filter(id => !protectedIds.has(id))]) {
      const country = request.conversationCountries[id];
      if (!['HN', 'PA'].includes(country)) throw new AppError(409, 'Falta el país congelado de una conversación.', 'DAILY_COUNTRY_UNKNOWN');
      if (counts[country] >= request.limitPerCountry) {
        if (protectedIds.has(id)) throw new AppError(409, 'Ya se iniciaron más conversaciones que el límite; no se descartará ese trabajo.', 'DAILY_LIMIT_ALREADY_EXCEEDED');
        continue;
      }
      selected.add(id); counts[country]++;
    }
    settings.dailyLimitPerCountry = request.limitPerCountry;
    settings.dailyConcurrency = request.concurrency;
    // Keep this date durable if the remaining country's job crosses midnight.
    settings.dailyCatchupRunDate = request.runDate;
    const hash = dailyActivityRequest(settings, request.runDate).dailyActivity.configurationHash;
    const deferred = { HN: 0, PA: 0 };
    for (const job of jobs) {
      const removed = job.conversationIds.filter(id => !selected.has(id));
      const previousHash = job.dailyActivity.configurationHash;
      job.conversationCountries = Object.fromEntries(job.conversationIds.map(id => [id, request.conversationCountries[id]]));
      job.originalConversationIds ??= [...job.conversationIds];
      job.deferredConversationIds = [...new Set([...(job.deferredConversationIds || []), ...removed])];
      job.conversationIds = job.conversationIds.filter(id => selected.has(id));
      job.caseCount = job.conversationIds.length;
      job.total = job.caseCount * job.modelProfiles.length;
      job.concurrency = request.concurrency;
      job.limitPerCountry = request.limitPerCountry;
      job.dailyActivity.configurationHash = hash;
      for (const id of removed) deferred[request.conversationCountries[id]]++;
      for (const task of state.tasks.filter(t => t.jobId === job.id && removed.includes(t.conversationId))) {
        if (task.status !== 'pending' || state.attempts.some(a => a.taskId === task.id)) throw new AppError(409, 'Una conversación excluida ya tiene trabajo.', 'DAILY_LIMIT_ALREADY_EXCEEDED');
        task.status = 'deferred'; task.deferredReason = 'daily-country-limit'; task.deferredAt = now.toISOString();
      }
      if (!terminal(job.status)) {
        job.dailyLimitAdjustment = { requestId, limitPerCountry: request.limitPerCountry, previousHash, appliedAt: now.toISOString() };
        job.status = job.total ? 'interrupted' : 'completed'; job.updatedAt = now.toISOString(); job.finishedAt = now.toISOString();
        for (const task of state.tasks.filter(t => t.jobId === job.id && t.status === 'running')) task.status = 'interrupted';
        for (const attempt of state.attempts.filter(a => a.jobId === job.id && a.status === 'running')) {
          attempt.status = 'interrupted'; attempt.finishedAt = now.toISOString();
        }
      }
    }
    const result = { requestId, activityDate: request.activityDate, limitPerCountry: request.limitPerCountry,
      concurrency: request.concurrency, selected: counts, deferred, appliedAt: now.toISOString() };
    settings.lastDailyLimitChange = result;
    delete settings.dailyLimitChange; delete settings.evaluationMaintenance;
    settings.version++; settings.updatedAt = now.toISOString();
    return { ...result, settingsVersion: settings.version };
  });
}
