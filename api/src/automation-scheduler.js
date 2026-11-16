import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { startEvaluationBatch, processTask, recoverEvaluationJobs } from './evaluation-service.js';
import { asRegistry } from './model-registry.js';
import { sourceFingerprint } from './evaluation-context.js';
import { activityOnDate, previousDate } from './daily-activity.js';
import { countryCanRun, migrateDailyAssignments, recordAutomationAlert, runtimeConfiguration, saveAutomationConfiguration, adoptLegacyAutomationJobs, automationSourceVersion } from './automation-configuration.js';
import { selectAutomationCandidates } from './automation-source.js';

const transient = code => ['AI_UNAVAILABLE', 'AI_TRANSIENT', 'AI_INCOMPLETE', 'AI_RESOURCE_LIMIT'].includes(code);
const readState = store => store.readAutomationState ? store.readAutomationState() : store.read();
const readSource = (store, ids) => store.readWithConversations ? store.readWithConversations({ fresh: true, conversationIds: ids }) : store.read();
const finished = task => ['completed', 'failed', 'partial', 'deferred'].includes(task.status);
const due = (task, date) => ['pending', 'interrupted'].includes(task.status)
  || task.status === 'retry_wait' && Date.parse(task.nextAttemptAt || 0) <= date.getTime();
function prerequisitesFinished(state, job, task) {
  if (job.executionOrder === 'parallel') return true;
  const earlier = job.modelProfiles.slice(0, job.modelProfiles.findIndex(p => p.id === task.profile.id)).map(p => p.id);
  return !state.tasks.some(t => t.jobId === job.id && earlier.includes(t.profile.id) && !finished(t)
    && countryCanRun(state.settings, job.conversationCountries[t.conversationId])
    && (job.executionOrder === 'model-first' || t.conversationId === task.conversationId));
}
const runnable = (state, job, task, date) => due(task, date)
  && !['SOURCE_CHANGED', 'RECONFIGURE_MODELS'].includes(task.error?.code)
  && countryCanRun(state.settings, job.conversationCountries[task.conversationId])
  && prerequisitesFinished(state, job, task);
export function automationClock(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const p = type => parts.find(part => part.type === type).value;
  return { date: `${p('year')}-${p('month')}-${p('day')}`, time: `${p('hour')}:${p('minute')}` };
}

export function refreshAutomationJob(state, job, date = new Date()) {
  const tasks = state.tasks.filter(t => t.jobId === job.id && t.status !== 'deferred');
  job.completed = tasks.filter(t => t.status === 'completed').length;
  job.partial = tasks.filter(t => t.status === 'partial').length;
  job.failed = tasks.filter(t => ['failed', 'partial'].includes(t.status)).length;
  job.errors = tasks.filter(t => t.error).map(t => ({ conversationId: t.conversationId, profileId: t.profile.id, ...t.error }));
  job.updatedAt = date.toISOString();
  if (tasks.every(finished)) {
    job.status = job.failed ? (job.completed || job.partial ? 'partial' : 'failed') : 'completed';
    job.finishedAt = date.toISOString();
  } else if (!tasks.some(t => !finished(t) && countryCanRun(state.settings, job.conversationCountries[t.conversationId]))) job.status = 'paused';
  else job.status = tasks.some(t => runnable(state, job, t, date)) ? 'queued' : 'retry_wait';
}

// Each mutation is fenced by the persisted worker token. A stale worker cannot
// publish after another process has recovered its expired heartbeat.
function fencedStore(store, job) {
  return {
    read: () => store.read(),
    ...(store.readWithConversations ? { readWithConversations: options => store.readWithConversations(options) } : {}),
    transaction: fn => store.transaction(state => {
      const current = state.jobs.find(j => j.id === job.id);
      if (current?.status !== 'running' || current.workerToken !== job.workerToken) throw new AppError(409, 'La ejecución fue recuperada por otro trabajador.', 'WORKER_REPLACED');
      return fn(state);
    }),
  };
}

export async function startAutomationWorker(store, evaluator, jobId, date = new Date()) {
  const claimed = await store.transaction(state => {
    if (state.jobs.some(j => j.status === 'running')) return null;
    const job = state.jobs.find(j => j.id === jobId);
    if (!job?.automation) return null;
    if (!state.tasks.some(t => t.jobId === jobId && runnable(state, job, t, date))) { refreshAutomationJob(state, job, date); return null; }
    const tasks = state.tasks.filter(t => t.jobId === jobId && due(t, date)
      && !['SOURCE_CHANGED', 'RECONFIGURE_MODELS'].includes(t.error?.code) && countryCanRun(state.settings, job.conversationCountries[t.conversationId]));
    if (!tasks.length) { refreshAutomationJob(state, job, date); return null; }
    Object.assign(job, { status: 'running', workerToken: randomUUID(), updatedAt: date.toISOString(), lastServedAt: date.toISOString(), finishedAt: null });
    return { job: structuredClone(job), tasks: structuredClone(tasks) };
  });
  if (!claimed) return null;
  return { job: claimed.job, completion: processAutomationQuantum(store, evaluator, claimed, date) };
}

async function processAutomationQuantum(store, evaluator, { job, tasks }, date) {
  const fenced = fencedStore(store, job);
  const config = job.automation.configuration;
  let heartbeatBusy = false;
  const timer = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try { await fenced.transaction(s => { s.jobs.find(j => j.id === job.id).updatedAt = new Date().toISOString(); }); } catch { /* A replaced worker cannot refresh its lease. */ }
    finally { heartbeatBusy = false; }
  }, 15000);
  timer.unref();
  try {
    const state = await readState(store);
    const registry = asRegistry(evaluator).forState(state).withRuntime(job.runtimeConfiguration);
    const catalog = job.catalogVersions.map(ref => {
      const snapshot = state.catalogVersions.find(v => v.itemId === ref.id && v.version === ref.version)?.snapshot;
      if (!snapshot) throw new AppError(409, 'Falta una versión del checklist.', 'MISSING_CATALOG_VERSION');
      return { ...snapshot, active: ref.active };
    });
    let quantum = tasks;
    if (job.executionOrder === 'model-first') {
      const phase = job.modelProfiles.find(p => tasks.some(t => t.profile.id === p.id));
      quantum = tasks.filter(t => t.profile.id === phase.id);
    }
    const ids = [...new Set(quantum.map(t => t.conversationId))].slice(0, config.blockSize);
    quantum = quantum.filter(t => ids.includes(t.conversationId));
    const run = async task => {
      const canRun = await fenced.transaction(s => {
        const current = s.tasks.find(t => t.id === task.id);
        if (!runnable(s, job, current, date)) return false;
        current.automaticAttempts = (current.automaticAttempts || 0) + 1;
        current.nextAttemptAt = null; current.status = 'running';
        return true;
      });
      if (!canRun) return;
      let error;
      try {
        const source = await readSource(store, [task.conversationId]);
        await processTask(fenced, registry, job, task, source.conversations.find(c => c.id === task.conversationId), catalog);
      } catch (caught) {
        if (caught.code === 'WORKER_REPLACED') throw caught;
        error = { code: caught instanceof AppError ? caught.code : 'EVALUATION_FAILED', message: caught instanceof AppError ? caught.message : 'No se pudo completar la evaluación.' };
      }
      await fenced.transaction(s => {
        const current = s.tasks.find(t => t.id === task.id);
        if (error && current.status !== 'completed') { current.error = error; current.status = 'failed'; }
        if (current.status !== 'completed' && current.error && transient(current.error.code) && current.automaticAttempts <= config.retries) {
          const delay = config.retryDelaysSeconds[Math.min(current.automaticAttempts - 1, config.retryDelaysSeconds.length - 1)];
          current.status = 'retry_wait'; current.nextAttemptAt = new Date(Math.max(date.getTime(), Date.now()) + delay * 1000).toISOString();
        }
        if (current.error) recordAutomationAlert(s.settings, { id: `task:${task.id}`, type: current.status === 'retry_wait' ? 'model_unavailable' : transient(current.error.code) ? 'retries_exhausted' : 'evaluation_attention',
          message: current.status === 'retry_wait' ? `${task.profile.label}: evaluación pendiente de reintento.` : `${task.profile.label}: ${current.error.message}`,
          country: job.conversationCountries[task.conversationId], modelId: task.profile.id, activityDate: job.automation.activityDate }, date);
        else {
          const alert = s.settings.automationRuntime?.alerts?.find(a => a.id === `task:${task.id}`);
          if (alert) alert.resolvedAt = date.toISOString();
        }
      });
    };
    const pool = async (items, concurrency, handler) => {
      const queue = [...items];
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => { while (queue.length) await handler(queue.shift()); }));
    };
    if (job.executionOrder === 'parallel') {
      await Promise.all(job.modelProfiles.map(p => pool(quantum.filter(t => t.profile.id === p.id), config.concurrency[p.id], run)));
    } else if (job.executionOrder === 'model-first') {
      await pool(quantum, config.concurrency[quantum[0].profile.id], run);
    } else {
      // Bound each model even when different conversations overlap.
      await pool(ids, Math.min(...Object.values(config.concurrency)), async id => {
        for (const p of job.modelProfiles) {
          const task = quantum.find(t => t.conversationId === id && t.profile.id === p.id);
          if (task) await run(task);
        }
      });
    }
    await fenced.transaction(s => refreshAutomationJob(s, s.jobs.find(j => j.id === job.id), date));
    return (await readState(store)).jobs.find(j => j.id === job.id);
  } catch (error) {
    if (error.code !== 'WORKER_REPLACED') await fenced.transaction(s => {
      const current = s.jobs.find(j => j.id === job.id);
      const attention = error instanceof AppError && !transient(error.code);
      for (const task of s.tasks.filter(t => t.jobId === job.id && (attention ? !finished(t) : t.status === 'running'))) {
        task.status = attention ? 'failed' : 'interrupted';
        task.error = { code: attention ? error.code : 'WORKER_INTERRUPTED', message: attention ? error.message : 'El trabajador fue interrumpido.' };
      }
      for (const attempt of s.attempts.filter(a => a.jobId === job.id && a.status === 'running')) {
        attempt.status = 'interrupted'; attempt.finishedAt = date.toISOString();
      }
      refreshAutomationJob(s, current, date);
      recordAutomationAlert(s.settings, { id: `job:${job.id}`, type: 'worker_error', message: 'La ejecución fue interrumpida; se conservaron los resultados guardados.', activityDate: job.automation.activityDate }, date);
    });
    throw error;
  } finally { clearInterval(timer); }
}

async function prepareChangedSelection(store, evaluator, state, date) {
  let inspected = 0;
  for (const job of state.jobs.filter(j => j.automation && j.status !== 'running')) {
    const tasks = state.tasks.filter(t => t.jobId === job.id && ['SOURCE_CHANGED', 'RECONFIGURE_MODELS'].includes(t.error?.code) && t.status !== 'deferred');
    for (const id of new Set([...tasks.map(t => t.conversationId), ...(job.sourceRecheckIds || [])])) {
      if (!countryCanRun(state.settings, job.conversationCountries[id]) || Date.parse(job.sourceRecheckAfter?.[id] || 0) > date.getTime()) continue;
      if (inspected++ >= state.settings.automation.blockSize) return false;
      try {
        const source = await readSource(store, [id]);
        const conversation = source.conversations.find(c => c.id === id);
        if (!conversation) throw new AppError(409, 'La conversación seleccionada todavía no está disponible en Atom.', 'SOURCE_UNAVAILABLE');
        const previous = state.tasks.find(t => t.jobId === job.id && t.conversationId === id);
        if (!tasks.some(t => t.conversationId === id && t.error?.code === 'RECONFIGURE_MODELS') && sourceFingerprint(conversation) === previous.context.sourceHash) {
          await store.transaction(s => {
            const j = s.jobs.find(j => j.id === job.id); j.sourceRecheckIds = (j.sourceRecheckIds || []).filter(value => value !== id);
            const a = s.dailyAssignments.find(a => a.jobId === job.id && a.conversationId === id);
            if (a) a.sourceVersion = automationSourceVersion(conversation);
            for (const task of s.tasks.filter(t => t.jobId === job.id && t.conversationId === id && t.error?.code === 'SOURCE_CHANGED' && t.status !== 'deferred')) {
              task.status = 'pending'; task.error = null; task.round++;
            }
          });
          continue;
        }
        await startEvaluationBatch(store, evaluator, { conversationIds: [id], max: 1, pendingOnly: false, includeOpen: job.automation.configuration.includeOpen,
          modelIds: job.modelProfiles.map(p => p.id), executionOrder: job.executionOrder, runtimeConfiguration: job.runtimeConfiguration,
          automation: { ...job.automation, revisionOf: job.id } });
        await store.transaction(s => {
          const alert = s.settings.automationRuntime?.alerts?.find(a => a.id === `revision:${job.id}:${id}`);
          if (alert) alert.resolvedAt = date.toISOString();
        });
        return true;
      } catch (error) {
        await store.transaction(s => {
          const j = s.jobs.find(j => j.id === job.id);
          (j.sourceRecheckAfter ||= {})[id] = new Date(date.getTime() + state.settings.automation.pollSeconds * 1000).toISOString();
          recordAutomationAlert(s.settings, { id: `revision:${job.id}:${id}`, type: 'revision_attention', country: job.conversationCountries[id], activityDate: job.automation.activityDate,
            message: error instanceof AppError ? error.message : 'No se pudo preparar la revisión. El resto de la cola puede continuar.' }, date);
        });
      }
    }
  }
  return false;
}

export async function runAutomationTick(store, evaluator, date = new Date()) {
  await recoverEvaluationJobs(store);
  let state = await readState(store);
  if (state.settings.automation && state.jobs.some(j => j.dailyActivity && !j.automation && !j.oneOffRun && j.status !== 'running' && state.tasks.some(t => t.jobId === j.id && !['completed', 'deferred'].includes(t.status)))) {
    await store.transaction(adoptLegacyAutomationJobs); state = await readState(store);
  }
  const config = state.settings.automation;
  const detectionVersion = state.settings.version;
  if (!config || !config.enabled || config.paused || state.settings.evaluationMaintenance) return null;
  const clock = automationClock(date, config.timezone);
  const activityDate = previousDate(clock.date);
  const runtime = state.settings.automationRuntime || {};
  if (clock.time >= config.time && (!runtime.lastDetectionAt || date.getTime() - Date.parse(runtime.lastDetectionAt) >= config.pollSeconds * 1000)) {
    // Claim a detection interval under the same lock used to reserve quota.
    const claimed = await store.transaction(s => {
      const current = s.settings.automationRuntime ||= {};
      if (s.settings.version !== state.settings.version || current.lastDetectionAt && date.getTime() - Date.parse(current.lastDetectionAt) < config.pollSeconds * 1000) return false;
      current.lastDetectionAt = date.toISOString(); return true;
    });
    if (claimed) {
      let source;
      try {
        source = store.readAutomationSource ? await store.readAutomationSource({ date: activityDate, timezone: config.timezone })
          : { ...await readSource(store), loads: [] };
        if (!store.readAutomationSource) source.conversations = source.conversations.filter(c => activityOnDate(c, activityDate, config.timezone) && c.messages?.some(m => m.text));
        await store.transaction(s => {
          migrateDailyAssignments(s);
          for (const row of source.conversations) {
            const assignment = s.dailyAssignments.find(a => a.activityDate === activityDate && a.country === row.country && a.conversationId === row.id);
            if (!assignment || assignment.sourceVersion === automationSourceVersion(row)) continue;
            const job = s.jobs.find(j => j.id === assignment.jobId && j.automation);
            if (job) job.sourceRecheckIds = [...new Set([...(job.sourceRecheckIds || []), row.id])];
          }
          const current = s.settings.automationRuntime;
          current.activityDate = activityDate; current.lastSuccessfulDetectionAt = date.toISOString();
          current.availability = Object.fromEntries(config.countries.map(c => [c.code, source.conversations.filter(row => row.country === c.code && (config.includeOpen || row.completed !== false)).length]));
          current.loads = source.loads || [];
          const newCountries = (source.countries || []).filter(country => !s.settings.automation.countries.some(c => c.code === country.code));
          if (newCountries.length) saveAutomationConfiguration(s, { expectedVersion: s.settings.version,
            automation: { ...s.settings.automation, countries: [...s.settings.automation.countries, ...newCountries.map(c => ({ code: c.code, name: c.name, enabled: false, paused: false, dailyLimit: 100 }))] } },
            { id: 'automation', name: 'Sincronización del catálogo de países' }, source.countries);
          const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
          for (const c of config.countries.filter(c => c.enabled)) {
            const hasLoad = source.loads?.some(l => l.country === c.code);
            const available = current.availability[c.code];
            if (hasLoad || available) {
              const alert = current.alerts?.find(a => a.id === `load:${activityDate}:${c.code}`);
              if (alert) alert.resolvedAt = date.toISOString();
            } else if (minutes(clock.time) - minutes(config.time) >= config.missingLoadMinutes) recordAutomationAlert(s.settings, {
              id: `load:${activityDate}:${c.code}`, type: 'missing_load', message: 'Todavía no se detecta carga disponible para este país.', country: c.code, activityDate }, date);
            if (hasLoad && !available) recordAutomationAlert(s.settings, { id: `empty:${activityDate}:${c.code}`, type: 'no_eligible', message: 'Se detectó carga, sin conversaciones elegibles para la jornada.', country: c.code, activityDate }, date);
            if (available) { const alert = current.alerts?.find(a => a.id === `empty:${activityDate}:${c.code}`); if (alert) alert.resolvedAt = date.toISOString(); }
          }
          const errorAlert = current.alerts?.find(a => a.id === 'source-unavailable');
          if (errorAlert) errorAlert.resolvedAt = date.toISOString();
        });
        state = await readState(store);
        const candidates = selectAutomationCandidates(source.conversations, state.dailyAssignments || [], config, activityDate);
        if (candidates.length) await startEvaluationBatch(store, evaluator, {
          conversationIds: candidates.map(c => c.id), max: candidates.length, pendingOnly: false, includeOpen: config.includeOpen,
          modelIds: config.modelOrder, executionOrder: config.executionOrder, runtimeConfiguration: runtimeConfiguration(config),
          automation: { activityDate, runDate: clock.date, configurationVersion: detectionVersion, configuration: structuredClone(config) },
        });
      } catch (error) {
        if (!['DAILY_ALREADY_STARTED', 'SCHEDULE_CHANGED'].includes(error.code)) await store.transaction(s => recordAutomationAlert(s.settings, {
          id: 'source-unavailable', type: 'detection_error', message: error instanceof AppError ? error.message : 'No se pudo consultar la carga. Se volverá a intentar.', activityDate }, date));
      }
    }
  }
  state = await readState(store);
  if (state.jobs.some(j => j.status === 'running')) return null;
  await prepareChangedSelection(store, evaluator, state, date);
  state = await readState(store);
  const candidates = state.jobs.filter(j => j.automation && state.tasks.some(t => t.jobId === j.id && runnable(state, j, t, date)))
    .sort((a, b) => (a.lastServedAt || a.createdAt).localeCompare(b.lastServedAt || b.createdAt));
  if (!candidates.length) return null;
  const execution = await startAutomationWorker(store, evaluator, candidates[0].id, date);
  if (execution) execution.completion.catch(error => console.error('Automatización Pulso:', error.code || error.name));
  return execution;
}
