import test from 'node:test';
import assert from 'node:assert/strict';
import { durationParts, durationLabel, dailyMessageActivity, metricEvidenceInterval } from '../src/services/metricPresentation.js';

const local = time => `2026-11-03T${time}-06:00`;
const message = (id, actor, timestamp) => ({ id, actor, timestamp, text: 'Texto que no debe copiarse al gráfico.' });
const day = { date: '2026-11-03', firstMessageAt: local('09:00:00'), lastMessageAt: local('09:30:00') };

test('durations use familiar units and carry rounding across second, minute and hour boundaries', () => {
  assert.deepEqual(durationParts(6.4), [{ value: 6, unit: 'min' }, { value: 24, unit: 's' }]);
  assert.equal(durationLabel(29.75), '29 min 45 s');
  assert.equal(durationLabel(999.999), '16 h 40 min');
  assert.equal(durationLabel(59.999), '1 h');
  assert.equal(durationLabel(0.99999), '1 min');
  assert.equal(durationLabel(60), '1 h');
  assert.equal(durationLabel(60 + 1 / 60), '1 h 1 s');
  assert.equal(durationLabel(61.5), '1 h 1 min 30 s');
  assert.deepEqual(durationParts(0), [{ value: 0, unit: 's' }]);
  assert.equal(durationLabel(0.0001), '0 s');
});

test('missing, nonnumeric and negative durations never look like a zero or a valid duration', () => {
  for (const invalid of [null, undefined, '', '6.4', NaN, Infinity, -Infinity, -0.1, {}, Number.MAX_VALUE]) {
    assert.equal(durationParts(invalid), null);
    assert.equal(durationLabel(invalid), 'No disponible');
  }
});

test('activity plots actual client, human and bot messages in timestamp order, excluding unknown/system events', () => {
  const conversation = { messages: [
    message('human', 'humano', local('09:06:24')),
    message('client', 'cliente', local('09:00:00')),
    message('bot', 'bot', local('09:01:00')),
    message('last', 'cliente', local('09:30:00')),
    message('system', 'sistema', local('09:02:00')),
    message('unknown', 'otro', local('09:03:00')),
    message('before', 'cliente', local('08:59:59')),
    message('after', 'cliente', local('09:30:01')),
  ] };
  const before = structuredClone(conversation);
  for (const item of conversation.messages) Object.freeze(item);
  Object.freeze(conversation.messages); Object.freeze(conversation);
  const activity = dailyMessageActivity(conversation, day);
  assert.deepEqual(activity.map(item => item.id), ['client', 'bot', 'human', 'last']);
  assert.equal(activity[0].position, 0);
  assert.equal(activity[2].position, 6.4 / 30);
  assert.equal(activity[3].position, 1);
  assert.ok(activity.every(item => Object.keys(item).join(',') === 'id,actor,timestamp,position'));
  assert.deepEqual(conversation, before);
});

test('activity respects local midnight, the day boundaries and explicit timezone rather than browser timezone', () => {
  const localNight = { date: '2026-11-03', firstMessageAt: '2026-11-04T05:58:00Z', lastMessageAt: '2026-11-04T05:59:59Z' };
  const conversation = { messages: [
    message('local-first', 'cliente', '2026-11-03T23:58:00-06:00'),
    message('same-instant', 'bot', '2026-11-04T07:59:59+02:00'),
    message('tomorrow', 'humano', '2026-11-04T06:00:00Z'),
  ] };
  assert.deepEqual(dailyMessageActivity(conversation, localNight).map(item => item.id), ['local-first', 'same-instant']);
  assert.deepEqual(dailyMessageActivity(conversation, localNight, 'UTC'), []);
  assert.deepEqual(dailyMessageActivity(conversation, { ...localNight, date: '2026-11-04' }, 'UTC').map(item => item.id), ['local-first', 'same-instant']);
  assert.deepEqual(dailyMessageActivity(conversation, localNight, 'Invalid/Timezone'), []);
});

test('invalid timestamps or windows produce no fabricated points; zero span retains real coincident messages', () => {
  const instant = local('09:00:00');
  const conversation = { messages: [
    message('a', 'cliente', instant), message('b', 'humano', instant),
    ...['invalid', null, -1, '2026-02-30T09:00:00-06:00', '2026-11-03T09:00:00'].map((timestamp, i) => message(`invalid-${i}`, 'cliente', timestamp)),
  ] };
  const instantDay = { ...day, firstMessageAt: instant, lastMessageAt: instant };
  const points = dailyMessageActivity(conversation, instantDay);
  assert.deepEqual(points.map(p => p.id), ['a', 'b']);
  assert.ok(points.every(p => p.position === 0.5));
  for (const invalidDay of [null, {}, { ...day, date: '2026-02-30' }, { ...day, lastMessageAt: local('08:00:00') }, { ...day, firstMessageAt: 'invalid' }]) {
    assert.deepEqual(dailyMessageActivity(conversation, invalidDay), []);
  }
  assert.deepEqual(dailyMessageActivity({}, day), []);
});

test('activity never truncates a dense day silently', () => {
  const messages = Array.from({ length: 600 }, (_, i) => message(`m-${i}`, i % 2 ? 'humano' : 'cliente', local('09:00:00')));
  assert.equal(dailyMessageActivity({ messages }, day).length, 600);
});

test('evidence interval requires two current-day messages from client to human and preserves data', () => {
  const conversation = { messages: [message('c', 'cliente', local('09:00:00')), message('h', 'humano', local('09:06:24'))] };
  const variable = { result: { status: 'evaluado', evidence: [{ messageId: 'h' }, { messageId: 'c' }] } };
  const snapshot = structuredClone({ conversation, variable, day });
  assert.deepEqual(metricEvidenceInterval(variable, conversation, day), { from: local('09:00:00'), to: local('09:06:24') });
  assert.deepEqual({ conversation, variable, day }, snapshot);
  assert.deepEqual(metricEvidenceInterval(variable, { messages: conversation.messages.map(m => ({ ...m, timestamp: local('09:00:00') })) }, day), { from: local('09:00:00'), to: local('09:00:00') });
});

test('stale, absent, incomplete or nonhuman evidence is not shown as the daily response interval', () => {
  const conversation = { messages: [
    message('c', 'cliente', local('09:00:00')), message('h', 'humano', local('09:06:24')),
    message('bot', 'bot', local('09:02:00')),
    message('older', 'cliente', '2026-11-02T09:00:00-06:00'),
    message('outside', 'humano', local('09:31:00')),
  ] };
  const item = (ids, status = 'evaluado') => ({ result: { status, evidence: ids.map(messageId => ({ messageId })) } });
  for (const variable of [null, item(['c']), item(['c', 'c']), item(['older', 'h']), item(['c', 'outside']), item(['c', 'bot']), item(['c', 'missing']), item(['c', 'h', 'bot']), item(['c', 'h'], 'no_evaluado')]) {
    assert.equal(metricEvidenceInterval(variable, conversation, day), null);
  }
});
