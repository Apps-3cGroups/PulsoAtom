import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationClock } from '../src/services/conversationTime.js';

const clock = zone => conversationClock({ displayTimezone: zone, displayTimezoneSource: 'country' });
test('Panama shows 20:39 on the preceding local date; host timezone never changes it', () => {
  const pa = clock('America/Panama'), hn = clock('America/Tegucigalpa');
  const value = '2026-11-16T01:39:00.000Z';
  assert.equal(pa.time(value), '20:39');
  assert.match(pa.date(value), /15.*nov.*2026/);
  assert.equal(hn.time(value), '19:39');
  assert.equal(pa.time('2026-11-15T20:39:00-05:00'), '20:39');
  assert.equal(pa.date('2026-11-16T04:59:00Z'), pa.date(value));
  assert.notEqual(pa.date('2026-11-16T05:00:00Z'), pa.date(value));
  assert.equal(pa.time('2026-11-16T05:00:00Z'), '00:00');
});

test('DST follows the instant, including skipped and repeated clock hours', () => {
  const ny = clock('America/New_York');
  assert.equal(ny.time('2026-03-08T06:59:00Z'), '01:59');
  assert.equal(ny.time('2026-03-08T07:00:00Z'), '03:00');
  assert.equal(ny.time('2026-11-01T05:30:00Z'), '01:30');
  assert.equal(ny.time('2026-11-01T06:30:00Z'), '01:30');
  const chile = clock('America/Santiago');
  assert.equal(chile.time('2026-01-15T12:00:00Z'), '09:00');
  assert.equal(chile.time('2026-07-15T12:00:00Z'), '08:00');
  const mexico = clock('America/Mexico_City');
  assert.equal(mexico.time('2022-07-15T12:00:00Z'), '07:00');
  assert.equal(mexico.time('2026-07-15T12:00:00Z'), '06:00');
});

test('missing zones are labeled UTC; missing or ambiguous timestamps are never interpreted in browser time', () => {
  for (const data of [{}, { displayTimezone: 'Invalid/Zone' }]) {
    const view = conversationClock(data);
    assert.equal(view.timezone, 'UTC');
    assert.match(view.label, /sin configurar/);
    for (const value of [null, '', 'invalid', '2026-11-16', '2026-11-16T01:39:00']) assert.equal(view.time(value), '—');
  }
  assert.match(conversationClock({ displayTimezone: 'America/Mexico_City', displayTimezoneSource: 'capital' }).label, /capital/);
});
