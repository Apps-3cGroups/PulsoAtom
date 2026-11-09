import { AppError } from './errors.js';
import { digest } from './evaluation-context.js';

export const DAILY_ACTIVITY_MODE = 'previous-day-activity';
export function previousDate(date) {
  return new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
export function activityOnDate(conversation, date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const matches = value => {
    if (!value || !Number.isFinite(Date.parse(value))) return false;
    const parts = formatter.formatToParts(new Date(value));
    const part = type => parts.find(p => p.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}` === date;
  };
  // A chat continuing today still belongs to yesterday's cohort if a message
  // was exchanged yesterday. Ingestion timestamps are never chat activity.
  return matches(conversation.lastActivityAt) || conversation.messages.some(message => matches(message.timestamp));
}
export function dailyActivityRequest(settings, runDate) {
  if (!settings.dailyEnabled || settings.dailyMode !== DAILY_ACTIVITY_MODE || !settings.dailyStartDate
    || (runDate < settings.dailyStartDate && settings.dailyManualRunDate !== runDate)
    || !settings.dailyCountries?.length || settings.dailyModelIds?.length !== 2) {
    throw new AppError(409, 'La programación diaria cambió o todavía no inicia.', 'SCHEDULE_CHANGED');
  }
  const snapshot = { mode: settings.dailyMode, enabled: settings.dailyEnabled, startedAt: settings.dailyStartedAt,
    startDate: settings.dailyStartDate, time: settings.dailyTime, timezone: settings.timezone,
    countries: settings.dailyCountries, modelIds: settings.dailyModelIds };
  return { scheduleDate: runDate, dailyActivity: { date: previousDate(runDate), timezone: settings.timezone, configurationHash: digest(snapshot) },
    countries: [...settings.dailyCountries], modelIds: [...settings.dailyModelIds], pendingOnly: false, includeOpen: true,
    executionOrder: 'model-first', concurrency: 1 };
}
export function validateDailyActivityRequest(settings, options) {
  const expected = dailyActivityRequest(settings, options.scheduleDate);
  if (Object.entries(expected).some(([key, value]) => digest(options[key] ?? null) !== digest(value))
    || ['from', 'to', 'country', 'sourceChangedAfter', 'conversationIds', 'random', 'largeBatch', 'maintenanceId', 'max'].some(key => options[key] !== undefined)
    || (options.purpose && options.purpose !== 'operational')) {
    throw new AppError(409, 'La selección no coincide con la programación diaria.', 'SCHEDULE_CHANGED');
  }
}
export function sameDailyCohort(job, options) {
  return job.scheduleDate === options.scheduleDate
    && job.dailyActivity?.timezone === options.dailyActivity?.timezone
    && digest((job.modelProfiles || []).map(p => p.id).sort()) === digest([...options.modelIds].sort());
}
