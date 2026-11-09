import { defaultDateRange, previousDate } from './dateRange.js';

const PRESETS = [1, 4, 7, 14, 30];
const DAY_MS = 86_400_000;
const FIRST_DATE = '0001-01-01';

function validDate(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const inclusiveDays = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS) + 1;

/** A saved custom range is independent of the anchor used by the shortcuts. */
export function resolveSummaryRange({ from, to, days, latest, mode, timezone = 'America/Tegucigalpa', now = new Date() } = {}) {
  const customRequested = (from != null && from !== '') || (to != null && to !== '');
  if (validDate(from) && validDate(to) && from <= to) {
    return { from, to, preset: null, totalDays: inclusiveDays(from, to) };
  }

  const preset = !customRequested && PRESETS.includes(Number(days)) ? Number(days) : 7;
  // Real operation always ends today in the portal's timezone. Only a demo
  // anchors its shortcuts to the fixed activity date of the synthetic data.
  const anchor = mode === 'demo' && validDate(latest) ? latest : undefined;
  const end = defaultDateRange(anchor, timezone, now).to;
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
