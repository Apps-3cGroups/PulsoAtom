import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationDailyMetrics, DAILY_METRICS_RULE_VERSION } from '../src/daily-metrics.js';
import { evaluateCodeVariables, CODE_RULES_VERSION } from '../src/code-evaluator.js';

const message = (id, actor, timestamp) => ({ id, actor, timestamp, text: 'Mensaje de prueba' });
const at = (day, time) => `2026-11-${day}T${time}:00-06:00`;
const result = (day, id) => day.metrics.find(metric => metric.id === id).result;
const value = (day, id) => result(day, id).value;

test('all seven metrics share one local day; days descend and the latest actual message day is the default', () => {
  const messages = [
    message('a', 'cliente', at('01', '09:00')), message('b', 'bot', at('01', '09:01')), message('c', 'humano', at('01', '09:04')),
    message('d', 'cliente', at('04', '15:00')), message('e', 'humano', at('04', '15:02')),
  ];
  const daily = conversationDailyMetrics({ messages, startedAt: at('01', '00:00'), updatedAt: at('08', '23:00'), completed: true });
  assert.equal(daily.ruleVersion, DAILY_METRICS_RULE_VERSION);
  assert.equal(daily.timezone, 'America/Tegucigalpa');
  assert.equal(daily.defaultDate, '2026-11-04');
  assert.equal(daily.unavailableReason, null);
  assert.deepEqual(daily.days.map(day => day.date), ['2026-11-04', '2026-11-01']);
  const [latest, older] = daily.days;
  assert.equal(latest.messageCount, 2);
  assert.deepEqual(latest.messageCounts, { cliente: 1, bot: 0, humano: 1, sistema: 0, desconocido: 0, asistente: 1, total: 2 });
  assert.deepEqual(older.messageCounts, { cliente: 1, bot: 1, humano: 1, sistema: 0, desconocido: 0, asistente: 2, total: 3 });
  assert.equal(latest.firstMessageAt, at('04', '15:00'));
  assert.equal(latest.lastMessageAt, at('04', '15:02'));
  assert.deepEqual(latest.metrics.map(metric => metric.result.value), [2, 2, 2, 1, 1, 1, 1]);
  assert.deepEqual(older.metrics.map(metric => metric.result.value), [4, 4, 4, 2, 1, 2, 2]);
  assert.equal(older.metrics.find(metric => metric.id === 'min_duracion_conversacion').name, 'Tiempo transcurrido del día');
  assert.ok(daily.days.every(day => day.metrics.length === 7 && day.metrics.every(metric => metric.type === 'Métrica'
    && metric.enabledInEvaluation && metric.result.variableId === metric.id && metric.result.codeRule.startsWith(DAILY_METRICS_RULE_VERSION))));
});

test('completed maximum survives a newer pending wait; bots and additional clients do not reset either interval', () => {
  const day = conversationDailyMetrics({ messages: [
    message('a', 'cliente', at('03', '09:00')), message('b', 'bot', at('03', '09:01')),
    message('c', 'cliente', at('03', '09:04')), message('d', 'humano', at('03', '09:11')),
    message('e', 'cliente', at('03', '09:14')), message('f', 'bot', at('03', '09:15')), message('g', 'humano', at('03', '09:19')),
    message('h', 'cliente', at('03', '09:20')), message('i', 'cliente', at('03', '09:24')), message('j', 'bot', at('03', '09:25')),
  ] }).days[0];
  assert.equal(value(day, 'min_primera_respuesta_humano'), 11);
  assert.equal(value(day, 'min_silencio_max_humano'), 11);
  assert.deepEqual(result(day, 'min_silencio_max_humano').evidence.map(item => item.messageId), ['a', 'd']);
  assert.deepEqual(day.pendingHumanWait, { startedAt: at('03', '09:20'), observedThrough: at('03', '09:25'), observedMinutes: 5, messageId: 'h' });
});

test('zero observed minutes still means pending, while a human response at the same instant is a completed zero-minute wait', () => {
  const single = message('a', 'cliente', at('03', '09:00'));
  const pending = conversationDailyMetrics({ messages: [single], completed: true }).days[0];
  assert.equal(value(pending, 'min_duracion_conversacion'), 0);
  assert.equal(value(pending, 'min_silencio_max_humano'), null);
  assert.equal(result(pending, 'min_silencio_max_humano').status, 'no_evaluado');
  assert.deepEqual(pending.pendingHumanWait, { startedAt: single.timestamp, observedThrough: single.timestamp, observedMinutes: 0, messageId: 'a' });
  const completed = conversationDailyMetrics({ messages: [single, message('b', 'humano', single.timestamp)] }).days[0];
  assert.equal(value(completed, 'min_silencio_max_humano'), 0);
  assert.equal(result(completed, 'min_silencio_max_humano').status, 'evaluado');
  assert.equal(completed.pendingHumanWait, null);
});

test('midnight crossings use the selected timezone, flag unconfirmed continuity on both days, and never become daily elapsed waits', () => {
  const messages = [message('a', 'cliente', '2026-11-04T05:58:00Z'), message('b', 'bot', '2026-11-04T05:59:00Z'),
    message('c', 'humano', '2026-11-04T06:03:00Z')];
  const daily = conversationDailyMetrics({ messages });
  const [responseDay, startDay] = daily.days;
  assert.deepEqual(daily.days.map(day => day.date), ['2026-11-04', '2026-11-03']);
  assert.equal(value(responseDay, 'min_silencio_max_humano'), null);
  assert.equal(value(startDay, 'min_silencio_max_humano'), null);
  assert.equal(value(startDay, 'min_duracion_conversacion'), 1);
  assert.equal(value(responseDay, 'min_duracion_conversacion'), 0);
  assert.equal(startDay.pendingHumanWait.observedMinutes, 1);
  assert.deepEqual(startDay.crossDayWaits, [{ startedAt: messages[0].timestamp, nextHumanAt: messages[2].timestamp,
    startDate: '2026-11-03', responseDate: '2026-11-04', continuity: 'unconfirmed', startMessageId: 'a', nextHumanMessageId: 'c' }]);
  assert.deepEqual(responseDay.crossDayWaits, startDay.crossDayWaits);
  const utc = conversationDailyMetrics({ messages }, { timezone: 'UTC' });
  assert.equal(utc.days.length, 1);
  assert.equal(value(utc.days[0], 'min_silencio_max_humano'), 5);
  assert.deepEqual(utc.days[0].crossDayWaits, []);
});

test('cross-day references keep the global first pending client while current-day metrics use only that day', () => {
  const [today, yesterday] = conversationDailyMetrics({ messages: [
    message('a', 'cliente', at('01', '09:00')), message('b', 'bot', at('01', '09:02')),
    message('c', 'cliente', at('04', '15:00')), message('d', 'humano', at('04', '15:03')),
    message('e', 'cliente', at('04', '15:04')),
  ] }).days;
  assert.equal(value(today, 'min_primera_respuesta_humano'), 3);
  assert.equal(value(today, 'min_silencio_max_humano'), 3);
  assert.equal(today.crossDayWaits[0].startMessageId, 'a');
  assert.equal(yesterday.crossDayWaits[0].nextHumanMessageId, 'd');
  assert.equal(today.pendingHumanWait.observedMinutes, 0);
  assert.equal(today.pendingHumanWait.messageId, 'e');
});

test('out-of-order messages are sorted without negative elapsed times or modification of input', () => {
  const original = { messages: [message('c', 'humano', at('03', '09:05')), message('a', 'cliente', at('03', '09:00')),
    message('b', 'bot', at('03', '09:01'))], evaluations: [{ id: 'historic', result: { value: 39900 } }] };
  const snapshot = structuredClone(original);
  original.messages.forEach(Object.freeze); Object.freeze(original.messages); Object.freeze(original);
  const day = conversationDailyMetrics(original).days[0];
  assert.equal(value(day, 'min_primera_respuesta_humano'), 5);
  assert.equal(value(day, 'min_silencio_max_humano'), 5);
  assert.equal(value(day, 'min_duracion_conversacion'), 5);
  assert.deepEqual(original, snapshot);
  day.metrics[0].result.evidence[0].quote = 'Resultado editado';
  assert.deepEqual(original, snapshot);
});

test('unassignable dates preserve valid days but make every metric unavailable without invented zero values or inferred waits', () => {
  const invalidTimestamps = ['invalid', '', null, undefined, -1, '-1', '2026-02-30T12:00:00Z'];
  const daily = conversationDailyMetrics({ messages: [message('a', 'cliente', at('01', '09:00')),
    ...invalidTimestamps.map((timestamp, index) => message(`bad-${index}`, 'bot', timestamp)),
    message('b', 'humano', at('04', '15:03'))] });
  assert.equal(daily.invalidTimestampCount, invalidTimestamps.length);
  assert.match(daily.unavailableReason, /fecha válida/u);
  assert.equal(daily.defaultDate, '2026-11-04');
  assert.deepEqual(daily.days.map(day => day.date), ['2026-11-04', '2026-11-01']);
  for (const day of daily.days) {
    assert.equal(day.messageCount, 1);
    assert.equal(day.messageCounts, null);
    assert.equal(day.pendingHumanWait, null);
    assert.deepEqual(day.crossDayWaits, []);
    assert.equal(day.metrics.length, 7);
    for (const metric of day.metrics) {
      assert.equal(metric.result.status, 'no_evaluado'); assert.equal(metric.result.value, null);
      assert.equal(metric.result.unavailableReason, 'INVALID_TIMESTAMP'); assert.deepEqual(metric.result.evidence, []);
    }
  }
  const allInvalid = conversationDailyMetrics({ messages: [message('a', 'cliente', null)] });
  assert.equal(allInvalid.defaultDate, null); assert.deepEqual(allInvalid.days, []); assert.equal(allInvalid.invalidTimestampCount, 1);
});

test('system and unknown actors cannot create days, extend elapsed time, break turns, or invalidate dates', () => {
  const daily = conversationDailyMetrics({ messages: [message('system-before', 'sistema', at('01', '09:00')),
    message('a', 'cliente', at('03', '09:00')), message('b', 'bot', at('03', '09:01')),
    message('system-between', 'sistema', 'invalid'), message('c', 'humano', at('03', '09:03')),
    message('unknown', 'otro', at('08', '09:00')), message('system-after', 'sistema', at('09', '09:00'))] });
  assert.equal(daily.days.length, 1); assert.equal(daily.invalidTimestampCount, 0);
  assert.equal(daily.defaultDate, '2026-11-03'); assert.equal(daily.days[0].messageCount, 3);
  assert.equal(value(daily.days[0], 'min_duracion_conversacion'), 3);
  assert.equal(value(daily.days[0], 'num_mensajes_por_turno_asistente'), 2);
  assert.equal(value(daily.days[0], 'num_mensajes_asistente'), 2);
  assert.equal(value(daily.days[0], 'num_mensajes_cliente'), 1);
});

test('zero counts and undefined ratios or turns keep their meanings; no messages means no fabricated day', () => {
  const assistantOnly = conversationDailyMetrics({ messages: [message('a', 'bot', at('03', '09:00'))] }).days[0];
  assert.equal(value(assistantOnly, 'num_mensajes_cliente'), 0);
  assert.equal(result(assistantOnly, 'ratio_mensajes_asistente_entre_cliente').unavailableReason, 'ZERO_DENOMINATOR');
  assert.equal(value(assistantOnly, 'ratio_mensajes_asistente_entre_cliente'), null);
  const clientOnly = conversationDailyMetrics({ messages: [message('a', 'cliente', at('03', '09:00'))] }).days[0];
  assert.equal(value(clientOnly, 'num_mensajes_asistente'), 0);
  assert.equal(value(clientOnly, 'ratio_mensajes_asistente_entre_cliente'), 0);
  assert.equal(result(clientOnly, 'num_mensajes_por_turno_asistente').unavailableReason, 'NO_ASSISTANT_TURNS');
  for (const conversation of [{}, { messages: [] }, { messages: [message('a', 'sistema', 'invalid')] }]) {
    const empty = conversationDailyMetrics(conversation);
    assert.equal(empty.defaultDate, null); assert.deepEqual(empty.days, []);
    assert.equal(empty.invalidTimestampCount, 0); assert.match(empty.unavailableReason, /No hay mensajes/u);
  }
});

test('daily display calculation does not change historical evaluator semantics or rule versions', () => {
  const messages = [message('a', 'cliente', at('03', '09:00')), message('b', 'humano', at('03', '09:05')),
    message('c', 'cliente', at('03', '09:06'))];
  const definition = { id: 'min_silencio_max_humano', type: 'Métrica', method: 'Código' };
  const historical = evaluateCodeVariables({ messages }, [definition])[0];
  assert.equal(value(conversationDailyMetrics({ messages }).days[0], definition.id), 5);
  assert.equal(historical.status, 'no_evaluado'); assert.equal(historical.value, null);
  assert.equal(historical.codeRule, `${CODE_RULES_VERSION}:${definition.id}`);
  assert.deepEqual(evaluateCodeVariables({ messages }, [definition])[0], historical);
});
