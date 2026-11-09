import { isMetricDate } from './dailyMetrics.js';

/** Display elapsed minutes in human units, rounded once to the nearest second. */
export function durationParts(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return null;
  const seconds = Math.round(minutes * 60);
  if (!Number.isSafeInteger(seconds)) return null;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts = [];
  if (hours) parts.push({ value: hours, unit: 'h' });
  if (mins) parts.push({ value: mins, unit: 'min' });
  if (secs || !parts.length) parts.push({ value: secs, unit: 's' });
  return parts;
}

export function durationLabel(minutes) {
  const parts = durationParts(minutes);
  return parts ? parts.map(({ value, unit }) => `${value} ${unit}`).join(' ') : 'No disponible';
}

function timestampMillis(value) {
  // Source timestamps must identify an instant; a timezone-free string would
  // otherwise produce a different chart on each user's computer.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return NaN;
  if (!isMetricDate(value.slice(0, 10))) return NaN;
  return Date.parse(value);
}

function dailyWindow(day, timezone) {
  if (!isMetricDate(day?.date)) return null;
  const from = timestampMillis(day.firstMessageAt), to = timestampMillis(day.lastMessageAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch { return null; }
  const dateOf = time => {
    const parts = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  if (dateOf(from) !== day.date || dateOf(to) !== day.date) return null;
  return { from, to, contains: time => Number.isFinite(time) && time >= from && time <= to && dateOf(time) === day.date };
}

/** Every point represents an available source message; no bucketing or samples. */
export function dailyMessageActivity(conversation, day, timezone = 'America/Tegucigalpa') {
  const window = dailyWindow(day, timezone);
  if (!window) return [];
  return (Array.isArray(conversation?.messages) ? conversation.messages : [])
    .filter(message => message && ['cliente', 'humano', 'bot'].includes(message.actor))
    .map(message => ({ message, milliseconds: timestampMillis(message.timestamp) }))
    .filter(entry => window.contains(entry.milliseconds))
    .sort((left, right) => left.milliseconds - right.milliseconds)
    .map(({ message, milliseconds }) => ({
      id: message.id, actor: message.actor, timestamp: message.timestamp,
      position: window.to === window.from ? 0.5 : (milliseconds - window.from) / (window.to - window.from),
    }));
}

/** Only expose an evidenced client → human interval from the displayed day. */
export function metricEvidenceInterval(variable, conversation, day, timezone = 'America/Tegucigalpa') {
  if (variable?.result?.status !== 'evaluado' || !Array.isArray(variable.result.evidence)) return null;
  const ids = [...new Set(variable.result.evidence.map(item => item?.messageId)
    .filter(id => id !== null && id !== undefined).map(String))];
  if (ids.length !== 2) return null;
  const activity = dailyMessageActivity(conversation, day, timezone);
  const messages = ids.map(id => activity.find(item => String(item.id) === id));
  if (messages.some(message => !message)) return null;
  messages.sort((left, right) => timestampMillis(left.timestamp) - timestampMillis(right.timestamp)
    || (left.actor === 'cliente' ? -1 : 1));
  const [start, response] = messages;
  if (start.actor !== 'cliente' || response.actor !== 'humano') return null;
  return { from: start.timestamp, to: response.timestamp };
}
