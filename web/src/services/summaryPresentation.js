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
