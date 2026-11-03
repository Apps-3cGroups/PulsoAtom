// Seven inclusive calendar days, anchored to the most recent loaded date.
export function previousDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}
export function defaultDateRange(latest, timezone = 'America/Tegucigalpa', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = type => parts.find(p => p.type === type).value;
  const to = latest || `${part('year')}-${part('month')}-${part('day')}`;
  return { from: previousDate(to, 6), to };
}
