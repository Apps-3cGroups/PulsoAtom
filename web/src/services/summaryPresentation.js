const dateFormatter = new Intl.DateTimeFormat('es-HN', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});

// The range contains calendar dates, not instants; never shift them by browser timezone.
const calendarLabel = date => dateFormatter.formatToParts(new Date(`${date}T12:00:00Z`))
  .filter(part => ['day', 'month', 'year'].includes(part.type))
  .map(part => part.value.replace(/\.$/, '')).join(' ');

export const summaryRangeLabel = (from, to) => from === to
  ? calendarLabel(from)
  : `${calendarLabel(from)} — ${calendarLabel(to)}`;

const percentageFormatter = new Intl.NumberFormat('es-HN', { maximumFractionDigits: 1 });

// Both rates use the same visible population as the conversation count and map.
// A missing/empty population has no percentage; a small positive count is never 0%.
export function summaryPercentage(count, total) {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0 || count < 0 || count > total) return '—';
  const percentage = count / total * 100;
  if (percentage > 0 && percentage < 0.1) return '<0.1%';
  if (percentage > 99.9 && percentage < 100) return '>99.9%';
  return `${percentageFormatter.format(percentage)}%`;
}
