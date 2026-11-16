import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTimezone, parseCountryTimezones } from '../src/conversation-timezone.js';
import { conversationView } from '../src/domain.js';
import { createState } from '../src/data/seed.js';
import { sourceFingerprint } from '../src/evaluation-context.js';

test('country and capital zones are explicit; unknown countries do not inherit Honduras', () => {
  for (const [country, zone] of Object.entries({ PA: 'America/Panama', HN: 'America/Tegucigalpa', MX: 'America/Mexico_City', CL: 'America/Santiago', BR: 'America/Sao_Paulo' })) {
    assert.equal(conversationTimezone({ country }).displayTimezone, zone);
  }
  assert.equal(conversationTimezone({ country: 'MX' }).displayTimezoneSource, 'capital');
  assert.deepEqual(conversationTimezone({ country: 'XX' }), { displayTimezone: 'UTC', displayTimezoneSource: 'fallback' });
});

test('explicit conversation zone wins over operational override; bad configuration fails early', () => {
  const overrides = parseCountryTimezones('{"MX":"America/Tijuana"}');
  assert.equal(conversationTimezone({ country: 'MX' }, overrides).displayTimezone, 'America/Tijuana');
  assert.equal(conversationTimezone({ country: 'MX', displayTimezone: 'America/Cancun' }, overrides).displayTimezone, 'America/Cancun');
  for (const invalid of ['bad', 'null', '[]', '{"mx":"UTC"}', '{"PA":"-05:00"}', '{"PA":"Bad/Zone"}']) assert.throws(() => parseCountryTimezones(invalid), /COUNTRY_TIMEZONES/);
});

test('summary and detail expose the same timezone without altering source UTC, quota day or fingerprint', () => {
  const state = createState(true);
  const conversation = state.conversations[0];
  conversation.country = 'PA';
  conversation.messages[0].timestamp = '2026-11-16T01:39:00.000Z';
  const before = structuredClone(conversation), hash = sourceFingerprint(conversation);
  for (const detail of [false, true]) {
    const view = conversationView(state, conversation, undefined, detail);
    assert.equal(view.displayTimezone, 'America/Panama');
    assert.equal(view.date, before.date);
    if (detail) assert.deepEqual(view.messages, before.messages);
  }
  assert.deepEqual(conversation, before);
  assert.equal(sourceFingerprint(conversation), hash);
});
