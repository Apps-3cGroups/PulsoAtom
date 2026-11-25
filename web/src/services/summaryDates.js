import { defaultDateRange, previousDate } from './dateRange.js';

export const SUMMARY_PRESETS = [1, 3, 30];
export const MAX_SUMMARY_DAYS = 31;
const DAY_MS = 86_400_000;
const FIRST_DATE = '0001-01-01';

function validDate(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const inclusiveDays = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS) + 1;

export function summaryRangeError(from, to) {
  if (!validDate(from) || !validDate(to)) return 'Selecciona una fecha inicial y una fecha final válidas.';
  if (from > to) return 'La fecha inicial no puede ser posterior a la final.';
  if (inclusiveDays(from, to) > MAX_SUMMARY_DAYS) return `Selecciona un máximo de ${MAX_SUMMARY_DAYS} días consecutivos.`;
  return null;
}

/** Explicit dates override quick periods, which end one calendar day behind. */
export function resolveSummaryRange({ from, to, days, latest, mode, timezone = 'America/Tegucigalpa', now = new Date() } = {}) {
  if (from !== undefined || to !== undefined) {
    const error = summaryRangeError(from, to);
    return { from: from || '', to: to || '', preset: null, totalDays: error ? 0 : inclusiveDays(from, to), ...(error ? { error } : {}) };
  }
  const preset = SUMMARY_PRESETS.includes(Number(days)) ? Number(days) : 3;
  // Subtract a calendar day after resolving the local date, never from the
  // browser's timezone or the newest ingestion. Demo keeps its fixed data cut.
  const end = mode === 'demo' && validDate(latest) ? latest
    : previousDate(defaultDateRange(undefined, timezone, now).to, 1);
  const availableDays = inclusiveDays(FIRST_DATE, end);
  const totalDays = Math.min(preset, availableDays);
  return { from: previousDate(end, totalDays - 1), to: end, preset: totalDays === preset ? preset : null, totalDays };
}

/** Page only the visible columns, never the query range or its totals. */
export function summaryDayWindow({ from, to, page = 1 } = {}, size = 31) {
  if (!validDate(from) || !validDate(to) || from > to) return { days: [], totalDays: 0, page: 1, pageCount: 0 };
  const totalDays = inclusiveDays(from, to);
  const pageSize = Number.isInteger(size) && size > 0 ? Math.min(size, 31) : 31;
  const pageCount = Math.ceil(totalDays / pageSize);
  const requestedPage = Number(page);
  const currentPage = Math.min(pageCount, Math.max(1, Number.isInteger(requestedPage) ? requestedPage : 1));
  const offset = (currentPage - 1) * pageSize;
  const days = Array.from({ length: Math.min(pageSize, totalDays - offset) }, (_, i) => previousDate(to, offset + i));
  return { days, totalDays, page: currentPage, pageCount };
}
