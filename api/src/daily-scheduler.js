import { startEvaluationBatch } from './evaluation-service.js';

export function scheduleClock(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = name => parts.find(item => item.type === name).value;
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

export async function runDailyTick(store, evaluator, now = new Date()) {
  const { settings, jobs } = await store.read();
  if (!settings.dailyEnabled || !settings.dailyStartedAt) return null;
  const clock = scheduleClock(now, settings.timezone);
  if (clock.time < settings.dailyTime || jobs.some(job => job.scheduleDate === clock.date)) return null;
  const { job, completion } = await startEvaluationBatch(store, evaluator, {
    pendingOnly: true, max: 100, sourceChangedAfter: settings.dailyStartedAt, scheduleDate: clock.date,
  });
  completion.catch(error => console.error('Error en evaluación diaria de Pulso:', error.code || error.name));
  return job;
}

export function startDailyScheduler(store, evaluator) {
  const tick = () => runDailyTick(store, evaluator).catch(error => {
    if (!['DAILY_ALREADY_STARTED', 'EVALUATION_RUNNING', 'SCHEDULE_CHANGED'].includes(error.code)) {
      console.error('Error al iniciar evaluación diaria de Pulso:', error.code || error.name);
    }
  });
  const timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
