import { runOneOffTick } from './one-off-scheduler.js';
import { startEvaluationBatch, recoverEvaluationJobs, resumeEvaluationBatch } from './evaluation-service.js';
import { asRegistry } from './model-registry.js';
import { DAILY_ACTIVITY_MODE, dailyActivityRequest } from './daily-activity.js';
import { thursdayRunDate, reconcileThursdayHandoff, THURSDAY_INGESTION } from './thursday-handoff.js';

export function scheduleClock(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = name => parts.find(item => item.type === name).value;
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

export async function runDailyTick(store, evaluator, now = new Date(), skipHandoff = false) {
  const state = await (store.readSchedulerState ? store.readSchedulerState() : store.read());
  const { settings, jobs } = state;
  if (settings.evaluationMaintenance || !settings.dailyEnabled || !settings.dailyStartedAt) return null;
  const handoff = settings.thursdayHandoff;
  if (handoff && handoff.status !== 'completed' && (now.toISOString() < handoff.notBefore
    || settings.tuesdayWednesdayCompletion?.status !== 'completed')) return null;
  const registry = asRegistry(evaluator).forState(state);
  const clock = scheduleClock(now, settings.timezone);
  const manualRun = settings.dailyMode === DAILY_ACTIVITY_MODE && settings.dailyManualRunDate === clock.date;
  if (!manualRun && clock.time < settings.dailyTime) return null;
  if (settings.dailyMode === DAILY_ACTIVITY_MODE) {
    if (!manualRun && clock.date < settings.dailyStartDate) return null;
    const preparedDate = skipHandoff ? null : thursdayRunDate(settings, now);
    const options = dailyActivityRequest(settings, preparedDate || settings.dailyCatchupRunDate || clock.date);
    for (const id of options.modelIds) registry.resolve(id);
    await recoverEvaluationJobs(store);
    const current = await (store.readSchedulerState ? store.readSchedulerState() : store.read());
    if (current.jobs.some(job => job.status === 'running')) return null;
    const interrupted = current.jobs.find(job => job.dailyActivity?.configurationHash === options.dailyActivity.configurationHash && job.status === 'interrupted' && !job.dailyResumeError);
    let execution;
    try {
      execution = interrupted ? await resumeEvaluationBatch(store, evaluator, interrupted.id, { unfinishedOnly: !!interrupted.dailyLimitAdjustment })
        : await startEvaluationBatch(store, evaluator, options);
    } catch (error) {
      if (interrupted && ['SOURCE_CHANGED', 'CATALOG_CHANGED', 'PROMPT_CHANGED', 'MODEL_CHANGED', 'SUPERSEDED_JOB'].includes(error.code)) {
        await store.transaction(draft => {
          const job = draft.jobs.find(j => j.id === interrupted.id);
          job.dailyResumeError = { code: error.code, message: error.message };
          job.errors = [...(job.errors || []), job.dailyResumeError];
        });
      }
      throw error;
    }
    const { job, completion } = execution;
    if (!job && options.dailyActivity.handoffId) await reconcileThursdayHandoff(store, { now });
    if (!job && settings.dailyCatchupRunDate) await store.transaction(draft => {
      if (draft.settings.dailyCatchupRunDate === settings.dailyCatchupRunDate) delete draft.settings.dailyCatchupRunDate;
    });
    completion.catch(error => console.error('Error en evaluación diaria de Pulso:', error.code || error.name));
    // Continue checking late Thursday imports first, but an exhausted partial
    // input must not indefinitely block subsequent ordinary activity days.
    if (!job && options.dailyActivity.handoffId && !skipHandoff && now.toISOString() >= THURSDAY_INGESTION.expiresAt) {
      return runDailyTick(store, evaluator, now, true);
    }
    return job;
  }
  if (!registry.policyAvailable(state) || jobs.some(job => job.scheduleDate === clock.date)) return null;
  const { job, completion } = await startEvaluationBatch(store, evaluator, {
    pendingOnly: true, max: 100, sourceChangedAfter: settings.dailyStartedAt, scheduleDate: clock.date,
  });
  completion.catch(error => console.error('Error en evaluación diaria de Pulso:', error.code || error.name));
  return job;
}

export function startDailyScheduler(store, evaluator) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { if (!await runOneOffTick(store, evaluator)) await runDailyTick(store, evaluator); } catch (error) {
      if (!['DAILY_ALREADY_STARTED', 'EVALUATION_RUNNING', 'SCHEDULE_CHANGED'].includes(error.code)) {
        console.error('Error al iniciar evaluación diaria de Pulso:', error.code || error.name);
      }
    } finally { busy = false; }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
