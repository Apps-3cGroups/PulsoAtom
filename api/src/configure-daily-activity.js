import { AppError } from './errors.js';
import { DAILY_ACTIVITY_MODE } from './daily-activity.js';
import { scheduleClock } from './daily-scheduler.js';

export const DAILY_MODELS = ['clef-local', 'gemma-local'];
export function inspectDailyActivity(state, registry) {
  const bound = registry.forState(state);
  const settings = state.settings;
  return { settingsVersion: settings.version, enabled: settings.dailyEnabled, mode: settings.dailyMode || 'legacy',
    time: settings.dailyTime, timezone: settings.timezone, startDate: settings.dailyStartDate || null,
    countries: settings.dailyCountries || [], modelIds: settings.dailyModelIds || [],
    maintenance: !!settings.evaluationMaintenance, runningJobs: state.jobs.filter(j => j.status === 'running').length,
    profiles: bound.list().filter(p => DAILY_MODELS.includes(p.id)),
    recentRuns: state.jobs.filter(j => j.dailyActivity).slice(-5).map(j => ({ id: j.id, status: j.status,
      date: j.dailyActivity.date, caseCount: j.caseCount, completed: j.completed, failed: j.failed })) };
}
export async function configureDailyActivity(store, registry, { startDate, expectedVersion, now = new Date() }) {
  const timezone = 'America/Tegucigalpa';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !Number.isFinite(Date.parse(`${startDate}T00:00:00Z`))
    || new Date(`${startDate}T00:00:00Z`).toISOString().slice(0, 10) !== startDate
    || startDate <= scheduleClock(now, timezone).date) throw new AppError(422, 'El primer día de ejecución debe ser una fecha futura.', 'INVALID_START_DATE');
  return store.transaction(state => {
    if (state.settings.version !== expectedVersion) throw new AppError(409, 'La configuración cambió. Consulta su versión vigente.', 'VERSION_CONFLICT');
    if (state.settings.evaluationMaintenance || state.jobs.some(j => j.status === 'running')) throw new AppError(409, 'Hay un mantenimiento o evaluación en curso.', 'EVALUATION_RUNNING');
    const bound = registry.forState(state), profiles = DAILY_MODELS.map(id => bound.resolve(id));
    if (profiles.some(p => p.provider !== 'gateway' || p.demo) || new Set(profiles.map(p => p.model)).size !== 2) throw new AppError(409, 'Se requieren Clef y Gemma configurados como modelos distintos.', 'LOCAL_MODELS_REQUIRED');
    state.settings = { ...state.settings, dailyEnabled: true, dailyMode: DAILY_ACTIVITY_MODE,
      dailyTime: '00:01', timezone, dailyStartDate: startDate, dailyCountries: ['HN', 'PA'], dailyModelIds: DAILY_MODELS,
      dailyStartedAt: now.toISOString(), version: state.settings.version + 1,
      updatedAt: now.toISOString(), updatedBy: 'Programación diaria HN/PA solicitada por Mario Cruz' };
    return inspectDailyActivity(state, registry);
  });
}
