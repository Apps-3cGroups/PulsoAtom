import { defaultDateRange } from './dateRange.js';

// Execution dates use today's portal timezone in real mode. Only explicit
// demonstrations anchor to their synthetic load date so their fixtures remain
// visible without widening the initial request to the whole history.
export function modelDashboardDefaultFilters(bootstrap = {}, now = new Date()) {
  const timezone = bootstrap.timezone || 'America/Tegucigalpa';
  const demo = bootstrap.mode === 'demo';
  const loadedAt = demo ? bootstrap.metadata?.lastLoadedAt : null;
  const loadedDate = loadedAt && Number.isFinite(Date.parse(loadedAt)) ? new Date(loadedAt) : null;
  const candidate = demo && !loadedDate ? bootstrap.dateRange?.max : null;
  const latest = typeof candidate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(candidate)
    && Number.isFinite(Date.parse(`${candidate}T12:00:00Z`))
    && new Date(`${candidate}T12:00:00Z`).toISOString().slice(0, 10) === candidate ? candidate : undefined;
  return { ...defaultDateRange(latest, timezone, loadedDate || now), country: '', left: '', right: '' };
}

export function resetModelDashboardFilters(filters, bootstrap, now) {
  return { ...modelDashboardDefaultFilters(bootstrap, now), left: filters.left || '', right: filters.right || '' };
}

export function modelDashboardPeriodLabel(filters, defaults) {
  if (!filters.from && !filters.to) return 'Todo el histórico';
  const range = `${filters.from || 'Inicio'} — ${filters.to || 'Sin límite'}`;
  return filters.from === defaults.from && filters.to === defaults.to ? `Últimos 7 días · ${range}` : range;
}

export const number = value => new Intl.NumberFormat('es-HN', { maximumFractionDigits: 1 }).format(value);
export const percentage = value => value === null || value === undefined ? 'Sin datos' : `${number(value * 100)} %`;
export const duration = value => value === null || value === undefined ? 'Sin datos' : value < 1000 ? `${number(value)} ms` : `${number(value / 1000)} s`;

export function metricLeader(models, key, lower = false) {
  if (models.length !== 2 || models.some(m => !Number.isFinite(m[key]))) return null;
  const difference = models[0][key] - models[1][key];
  if (Math.abs(difference) < 1e-9) return { tie: true, label: 'Empate' };
  const index = lower ? (difference < 0 ? 0 : 1) : (difference > 0 ? 0 : 1);
  return { index, label: models[index].label, value: models[index][key], other: models[1 - index][key] };
}

export function comparisonScale(values, ceiling) {
  const max = ceiling ?? Math.max(0, ...values.filter(Number.isFinite));
  return values.map(value => !Number.isFinite(value) ? null : max > 0 ? Math.max(0, Math.min(100, value / max * 100)) : 0);
}
