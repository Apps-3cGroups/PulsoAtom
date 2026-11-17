// The API resolves the country's operational zone. No browser-local parsing or
// fixed UTC offsets: Intl applies the civil-time rules for the message's date.
const formatters = new Map();
export function conversationClock(conversation) {
  let timezone = conversation?.displayTimezone;
  try {
    if (!timezone) throw new Error();
    if (!formatters.has(timezone)) formatters.set(timezone, {
      date: new Intl.DateTimeFormat('es-HN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: timezone }),
      time: new Intl.DateTimeFormat('es-HN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone }),
    });
  }
  catch { timezone = 'UTC'; }
  if (!formatters.has(timezone)) return conversationClock({ displayTimezone: 'UTC', displayTimezoneSource: 'fallback' });
  const source = conversation?.displayTimezoneSource;
  const label = timezone !== conversation?.displayTimezone || timezone === 'UTC' && (!source || source === 'fallback') ? 'Hora UTC · zona local sin configurar'
    : source === 'capital' ? `Hora local de la capital · ${timezone}` : `Hora local · ${timezone}`;
  const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
  const format = (value, formatter, missing) => {
    const date = instant(value);
    return date ? formatter.format(date) : missing;
  };
  const date = value => format(value, formatters.get(timezone).date, 'Fecha no disponible');
  const time = value => format(value, formatters.get(timezone).time, '—');
  return { timezone, label, date, time, dateTime: value => `${date(value)} · ${time(value)}` };
}
