import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyMetricsView, isMetricDate, metricDateText, metricTimeText, withMetricDate } from '../src/services/dailyMetrics.js';
import { metricValue } from '../src/services/flags.js';

const days = [
  { date: '2026-10-14', messageCount: 8, metrics: [{ id: 'num_mensajes_asistente', result: { status: 'evaluado', value: 5 } }] },
  { date: '2026-11-02', messageCount: 1, metrics: [{ id: 'num_mensajes_asistente', result: { status: 'evaluado', value: 0 } }] },
];
const daily = { timezone: 'America/Tegucigalpa', defaultDate: '2026-11-02', days, invalidTimestampCount: 0, unavailableReason: null };

test('el día predeterminado es el último con mensajes, aunque el arreglo venga desordenado', () => {
  const view = dailyMetricsView(daily);
  assert.equal(view.selectedDate, '2026-11-02');
  assert.deepEqual(view.days.map(day => day.date), ['2026-11-02', '2026-10-14']);
  assert.deepEqual(daily.days.map(day => day.date), ['2026-10-14', '2026-11-02']);
});

test('el enlace conserva un día existente y restablece fechas inválidas o ajenas al chat', () => {
  assert.equal(dailyMetricsView(daily, '2026-10-14').selectedDay, days[0]);
  for (const date of ['2026-02-30', '2026-10-13', 'bad-date', '']) {
    assert.equal(dailyMetricsView(daily, date).selectedDate, '2026-11-02');
  }
  assert.equal(dailyMetricsView({ ...daily, days: [null, { date: '2026-11-03', messageCount: 0 }, { date: '2026-02-30', messageCount: 4 }, ...days] }).selectedDate, '2026-11-02');
});

test('cambiar o restablecer el día preserva el mensaje enlazado y los demás parámetros', () => {
  const original = new URLSearchParams('message=msg-7&view=review&metricDate=bad-date');
  const updated = withMetricDate(original, dailyMetricsView(daily, original.get('metricDate')).selectedDate);
  assert.equal(updated.toString(), 'message=msg-7&view=review&metricDate=2026-11-02');
  assert.equal(original.get('metricDate'), 'bad-date');
  assert.equal(withMetricDate(updated, null).toString(), 'message=msg-7&view=review');
});

test('cero calculado se conserva y un resultado sin datos nunca se convierte en cero', () => {
  assert.equal(metricValue(dailyMetricsView(daily).selectedDay.metrics[0]), 0);
  assert.equal(metricValue({ result: { status: 'no_evaluado', value: 0 } }), null);
  assert.equal(metricValue({ result: { status: 'evaluado', value: null } }), null);
  assert.equal(metricValue({ result: { status: 'evaluado', value: Infinity } }), null);
});

test('una API anterior no usa el acumulado histórico como cifra diaria', () => {
  const conversation = { metrics: [{ id: 'min_duracion_conversacion', result: { status: 'evaluado', value: 39900 } }] };
  const view = dailyMetricsView(conversation.dailyMetrics);
  assert.equal(view.selectedDay, null);
  assert.equal(view.selectedDate, null);
  assert.match(view.unavailableReason, /evaluación histórica se conserva/);
  assert.equal(view.days.length, 0);
});

test('sin fechas válidas conserva la razón del API y el recuento omitido', () => {
  const view = dailyMetricsView({ ...daily, days: [], defaultDate: null, invalidTimestampCount: 3, unavailableReason: 'Los mensajes no tienen una fecha válida.' });
  assert.equal(view.selectedDay, null);
  assert.equal(view.unavailableReason, 'Los mensajes no tienen una fecha válida.');
  assert.equal(view.invalidTimestampCount, 3);
  assert.match(dailyMetricsView({ days: [] }).unavailableReason, /No hay mensajes/);
});

test('fecha calendario y horas usan el día del API, sin desplazamiento del navegador', () => {
  assert.equal(metricDateText('2026-11-02'), new Intl.DateTimeFormat('es-HN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date('2026-11-02T00:00:00Z')));
  assert.equal(metricTimeText('2026-11-03T01:30:00Z', 'America/Tegucigalpa'), '19:30');
  assert.equal(metricTimeText('invalid', 'America/Tegucigalpa'), 'Hora no disponible');
  assert.equal(metricTimeText('2026-11-03T01:30:00Z', 'Invalid/Zone'), 'Hora no disponible');
  assert.equal(isMetricDate('2024-02-29'), true);
  assert.equal(isMetricDate('2026-02-29'), false);
});

test('una espera pendiente no reemplaza el máximo completado ni usa el reloj actual', () => {
  const completed = { id: 'min_silencio_max_humano', result: { status: 'evaluado', value: 8 } };
  const pendingHumanWait = { startedAt: '2026-11-02T17:00:00Z', observedThrough: '2026-11-02T17:00:00Z', observedMinutes: 0, messageId: 'm-9' };
  const view = dailyMetricsView({ ...daily, days: [{ ...days[1], metrics: [completed], pendingHumanWait }] });
  assert.equal(metricValue(view.selectedDay.metrics[0]), 8);
  assert.equal(view.selectedDay.pendingHumanWait.observedMinutes, 0);
  assert.equal(view.selectedDay.pendingHumanWait.observedThrough, '2026-11-02T17:00:00Z');
});
