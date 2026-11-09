import { messageCounts } from './message-counts.js';
import { evaluateCodeVariables } from './code-evaluator.js';

export const DAILY_METRICS_RULE_VERSION = 'pulso-daily-metrics-v1';

const definitions = [
  ['min_primera_respuesta_humano', 'Primera respuesta humana', 'Código', 'min'],
  ['min_silencio_max_humano', 'Mayor silencio humano', 'Código', 'min'],
  ['min_duracion_conversacion', 'Tiempo transcurrido del día', 'Código', 'min'],
  ['num_mensajes_asistente', 'Mensajes del asistente', 'Código', 'messages'],
  ['num_mensajes_cliente', 'Mensajes del cliente', 'Código', 'messages'],
  ['ratio_mensajes_asistente_entre_cliente', 'Relación de mensajes asistente / cliente', 'Cálculo', 'ratio'],
  ['num_mensajes_por_turno_asistente', 'Mensajes por turno del asistente', 'Código', 'messages_per_turn'],
].map(([id, name, method, unit]) => ({ id, name, method, unit, type: 'Métrica' }));

const silenceId = 'min_silencio_max_humano';
const evidence = messages => messages.map(message => ({ messageId: message.id, quote: String(message.text || '').slice(0, 2000) }));
const elapsed = (start, end) => (end.milliseconds - start.milliseconds) / 60000;

function timestampMillis(timestamp) {
  // Date.parse accepts numeric strings such as "-1" as calendar dates.
  if (typeof timestamp !== 'string' || !timestamp.trim() || /^[+-]?\d+(?:\.\d+)?$/u.test(timestamp.trim())) return NaN;
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return NaN;
  // Reject overflowing ISO dates that Date.parse silently normalizes (e.g. February 30).
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:T|\s|$)/u.exec(timestamp);
  if (date) {
    const [, year, month, day] = date.map(Number);
    const calendar = new Date(0);
    calendar.setUTCFullYear(year, month - 1, day);
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return NaN;
  }
  return milliseconds;
}

function humanWaits(ordered) {
  let pending = null, longest = null;
  const pairs = [];
  for (const entry of ordered) {
    if (entry.message.actor === 'cliente' && !pending) pending = entry;
    if (entry.message.actor === 'humano' && pending) {
      const pair = { start: pending, response: entry, minutes: elapsed(pending, entry) };
      pairs.push(pair);
      if (!longest || pair.minutes > longest.minutes) longest = pair;
      pending = null;
    }
  }
  return { pending, longest, pairs };
}

function silenceResult(wait) {
  if (wait.longest) return {
    status: 'evaluado', value: wait.longest.minutes,
    reason: 'Mayor espera completada entre el primer mensaje pendiente del cliente y la siguiente respuesta humana del mismo día. El bot y los mensajes adicionales del cliente no reinician la espera; una espera pendiente se muestra por separado.',
    evidence: evidence([wait.longest.start.message, wait.longest.response.message]),
  };
  return {
    status: 'no_evaluado', value: null, evidence: [],
    reason: wait.pending ? 'No hay una espera completada con respuesta humana en este día; la espera pendiente se muestra por separado.'
      : 'No hay una espera del cliente con respuesta humana en este día.',
    unavailableReason: wait.pending ? 'UNRESOLVED_HUMAN_WAIT' : 'NO_HUMAN_WAIT',
  };
}

/** Derives daily display metrics without changing conversations or saved evaluations. */
export function conversationDailyMetrics(conversation, { timezone = 'America/Tegucigalpa' } = {}) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateOf = milliseconds => {
    const parts = Object.fromEntries(formatter.formatToParts(milliseconds).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const messages = (Array.isArray(conversation?.messages) ? conversation.messages : [])
    .filter(message => message && ['cliente', 'humano', 'bot'].includes(message.actor));
  const entries = messages.map(message => ({ message, milliseconds: timestampMillis(message.timestamp) }));
  const invalidTimestampCount = entries.filter(entry => !Number.isFinite(entry.milliseconds)).length;
  const ordered = entries.filter(entry => Number.isFinite(entry.milliseconds))
    .toSorted((left, right) => left.milliseconds - right.milliseconds)
    .map(entry => ({ ...entry, date: dateOf(entry.milliseconds) }));
  const unavailableReason = invalidTimestampCount
    ? 'Hay mensajes sin una fecha válida que no se pueden asignar a un día; las métricas diarias no están disponibles hasta corregir esas fechas.'
    : !messages.length ? 'No hay mensajes del cliente, del bot o de un asistente humano para calcular métricas diarias.' : null;
  const groups = new Map();
  for (const entry of ordered) {
    if (!groups.has(entry.date)) groups.set(entry.date, []);
    groups.get(entry.date).push(entry);
  }

  const days = [...groups.entries()].map(([date, daily]) => {
    const dailyMessages = daily.map(entry => entry.message);
    const wait = invalidTimestampCount ? null : humanWaits(daily);
    const results = invalidTimestampCount ? new Map() : new Map(evaluateCodeVariables(
      { ...conversation, messages: dailyMessages }, definitions.filter(definition => definition.id !== silenceId),
    ).map(result => [result.variableId, result]));
    const metrics = definitions.map(({ id, name, method, type, unit }) => {
      const result = invalidTimestampCount
        ? { status: 'no_evaluado', value: null, reason: unavailableReason, unavailableReason: 'INVALID_TIMESTAMP', evidence: [] }
        : id === silenceId ? silenceResult(wait) : results.get(id);
      return {
        id, name, type, enabledInEvaluation: true,
        result: {
          ...result, variableId: id, method, unit, codeRule: `${DAILY_METRICS_RULE_VERSION}:${id}`,
          reason: !invalidTimestampCount && id === 'min_duracion_conversacion'
            ? 'Tiempo transcurrido entre el primer y el último mensaje del día seleccionado. Incluye pausas dentro del día; no divide la conversación en atenciones.'
            : result.reason,
        },
      };
    });
    const pendingHumanWait = wait?.pending ? {
      startedAt: wait.pending.message.timestamp,
      observedThrough: daily.at(-1).message.timestamp,
      observedMinutes: elapsed(wait.pending, daily.at(-1)),
      messageId: wait.pending.message.id,
    } : null;
    return {
      date, firstMessageAt: daily[0].message.timestamp, lastMessageAt: daily.at(-1).message.timestamp,
      messageCount: daily.length, messageCounts: invalidTimestampCount ? null : messageCounts(dailyMessages), metrics, pendingHumanWait, crossDayWaits: [],
    };
  });

  // A later human message alone cannot establish continuity across calendar days.
  if (!invalidTimestampCount) {
    const byDate = new Map(days.map(day => [day.date, day]));
    for (const { start, response } of humanWaits(ordered).pairs) {
      if (start.date === response.date) continue;
      const crossDayWait = {
        startedAt: start.message.timestamp, nextHumanAt: response.message.timestamp,
        startDate: start.date, responseDate: response.date, continuity: 'unconfirmed',
        startMessageId: start.message.id, nextHumanMessageId: response.message.id,
      };
      byDate.get(start.date).crossDayWaits.push({ ...crossDayWait });
      byDate.get(response.date).crossDayWaits.push({ ...crossDayWait });
    }
  }
  days.sort((left, right) => right.date.localeCompare(left.date));
  return { ruleVersion: DAILY_METRICS_RULE_VERSION, timezone, defaultDate: days[0]?.date ?? null, days, invalidTimestampCount, unavailableReason };
}
