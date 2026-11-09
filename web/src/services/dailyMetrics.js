const calendarDate = /^\d{4}-\d{2}-\d{2}$/;

export function isMetricDate(value) {
  if (typeof value !== 'string' || !calendarDate.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function dailyMetricsView(dailyMetrics, requestedDate) {
  const seen = new Set();
  const days = (Array.isArray(dailyMetrics?.days) ? dailyMetrics.days : [])
    .filter(day => {
      if (!isMetricDate(day?.date) || !Number.isFinite(day.messageCount) || day.messageCount <= 0 || seen.has(day.date)) return false;
      seen.add(day.date);
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  const selectedDay = days.find(day => day.date === requestedDate) || days[0] || null;
  const unavailableReason = !dailyMetrics
    ? 'Las métricas por día no están disponibles en esta versión de los datos. La evaluación histórica se conserva en el checklist.'
    : dailyMetrics.unavailableReason || (!days.length ? 'No hay mensajes con fecha válida para calcular las métricas del día.' : null);

  return {
    days,
    selectedDay,
    selectedDate: selectedDay?.date || null,
    timezone: dailyMetrics?.timezone || null,
    unavailableReason,
    invalidTimestampCount: Number.isInteger(dailyMetrics?.invalidTimestampCount) && dailyMetrics.invalidTimestampCount > 0 ? dailyMetrics.invalidTimestampCount : 0,
  };
}

// A calendar date is already in the API's reporting timezone. Format its parts
// in UTC so the browser's timezone cannot move it to the previous day.
export function metricDateText(value) {
  if (!isMetricDate(value)) return 'Fecha no disponible';
  return new Intl.DateTimeFormat('es-HN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00.000Z`));
}

export function metricTimeText(value, timezone) {
  if (!value || !timezone) return 'Hora no disponible';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Hora no disponible';
  try {
    return new Intl.DateTimeFormat('es-HN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone }).format(date);
  } catch {
    return 'Hora no disponible';
  }
}

export function withMetricDate(searchParams, date) {
  const next = new URLSearchParams(searchParams);
  if (isMetricDate(date)) next.set('metricDate', date);
  else next.delete('metricDate');
  return next;
}
