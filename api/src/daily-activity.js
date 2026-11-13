import { AppError } from './errors.js';
import { digest } from './evaluation-context.js';
import { completedOperationalPair, dailyHandoffFor } from './daily-equivalence.js';

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
    countries: settings.dailyCountries, modelIds: settings.dailyModelIds,
    ...(settings.dailyLimitPerCountry != null ? { limitPerCountry: settings.dailyLimitPerCountry } : {}),
    ...(settings.dailyConcurrency != null ? { concurrency: settings.dailyConcurrency } : {}) };
  const handoff = settings.thursdayHandoff?.runDate === runDate ? settings.thursdayHandoff : null;
  return { scheduleDate: runDate, dailyActivity: { date: previousDate(runDate), timezone: settings.timezone, configurationHash: digest(handoff ? { ...snapshot, handoff: handoff.scopeHash } : snapshot),
      ...(handoff ? { handoffId: handoff.id, handoffScopeHash: handoff.scopeHash } : {}) },
    countries: [...settings.dailyCountries], modelIds: [...settings.dailyModelIds], pendingOnly: false, includeOpen: true,
    executionOrder: handoff ? 'conversation-first' : 'model-first', concurrency: handoff?.concurrency ?? settings.dailyConcurrency ?? 1,
    ...(handoff ? { limitPerCountry: handoff.limitPerCountry } : settings.dailyLimitPerCountry != null ? { limitPerCountry: settings.dailyLimitPerCountry } : {}) };
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

// Stable order is shared by quota selection and coverage, independent of import order.
export const stableDailyConversations = rows => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
// Reused pairs and new tasks consume one unique ID. Jobs freeze that ledger so
// changed or disappearing source records cannot reopen previously consumed slots.
export function dailyAssignedCountries(state, options, { includeReusable = true } = {}) {
  const countries = new Map((state.conversations || []).map(c => [c.id, c.country]));
  const assigned = new Map(), handoff = dailyHandoffFor(state.settings, options);
  const jobs = state.jobs.filter(j => j.dailyActivity?.date === options.dailyActivity.date
    && j.dailyActivity.timezone === options.dailyActivity.timezone).sort((a, b) =>
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  for (const job of jobs) {
    if (handoff) for (const [id, country] of Object.entries(job.dailyQuotaCountries || {})) if (!assigned.has(id)) assigned.set(id, country);
    for (const id of job.conversationIds) {
      const country = job.conversationCountries?.[id] || countries.get(id);
      if (!country) throw new AppError(409, 'No se pudo verificar el país de una conversación ya asignada.', 'DAILY_COUNTRY_UNKNOWN');
      if (!assigned.has(id)) assigned.set(id, country);
    }
  }
  if (handoff && includeReusable) {
    const counts = countsOf(assigned);
    for (const c of stableDailyConversations(state.conversations || [])) {
      if (assigned.has(c.id) || !handoff.countries.includes(c.country)
        || (counts[c.country] || 0) >= options.limitPerCountry
        || !activityOnDate(c, handoff.activityDate, handoff.timezone)
        || !completedOperationalPair(state, c, handoff.profiles)) continue;
      assigned.set(c.id, c.country); counts[c.country] = (counts[c.country] || 0) + 1;
    }
  }
  return assigned;
}
const countsOf = assigned => [...assigned.values()].reduce((counts, country) => ({ ...counts, [country]: (counts[country] || 0) + 1 }), {});
export const dailyAssignedCounts = (state, options) => countsOf(dailyAssignedCountries(state, options));
export function hasNewDailyQuotaEntries(state, options) {
  if (!dailyHandoffFor(state.settings, options)) return false;
  const frozen = dailyAssignedCountries(state, options, { includeReusable: false });
  return [...dailyAssignedCountries(state, options).keys()].some(id => !frozen.has(id));
}
export function withinDailyLimit(state, candidates, options) {
  if (options.limitPerCountry == null) return candidates;
  if (!Number.isInteger(options.limitPerCountry) || options.limitPerCountry < 1 || options.limitPerCountry > 1000) {
    throw new AppError(422, 'El límite por país es inválido.', 'INVALID_DAILY_LIMIT');
  }
  const handoff = dailyHandoffFor(state.settings, options), assigned = dailyAssignedCountries(state, options), used = countsOf(assigned);
  return (handoff ? stableDailyConversations(candidates) : candidates).filter(c => {
    if (handoff && assigned.has(c.id)) return true;
    if ((used[c.country] || 0) >= options.limitPerCountry) return false;
    used[c.country] = (used[c.country] || 0) + 1;
    return true;
  });
}
