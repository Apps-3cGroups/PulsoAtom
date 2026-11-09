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
