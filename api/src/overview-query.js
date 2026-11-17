// Convert a local date boundary to UTC without relying on the database timezone tables.
export function localMidnight(date, timezone) {
  let instant = new Date(`${date}T00:00:00.000Z`).getTime();
  const target = instant;
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const parts = format.formatToParts(new Date(instant));
    const part = type => parts.find(p => p.type === type).value;
    const local = Date.parse(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`);
    const correction = target - local; instant += correction;
    if (!correction) break;
  }
  return new Date(instant);
}
export const nextDate = date => new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
