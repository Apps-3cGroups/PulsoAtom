import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryRangeLabel, summaryPercentage } from '../src/services/summaryPresentation.js';

test('summary range omits connecting words and repeats no date for today', () => {
  assert.equal(summaryRangeLabel('2026-11-09', '2026-11-11'), '9 nov 2026 — 11 nov 2026');
  assert.equal(summaryRangeLabel('2026-11-11', '2026-11-11'), '11 nov 2026');
});

test('flag and positive rates express a share of the visible conversation count', () => {
  assert.equal(summaryPercentage(146, 435), '33.6%');
  assert.equal(summaryPercentage(11, 435), '2.5%');
  assert.equal(summaryPercentage(0, 435), '0%');
  assert.equal(summaryPercentage(435, 435), '100%');
  assert.equal(summaryPercentage(8, 12), '66.7%');
  assert.equal(summaryPercentage(4, 12), '33.3%');
});

test('empty/loading metrics do not invent a rate and rounding retains nonzero and non-total shares', () => {
  assert.equal(summaryPercentage(0, 0), '—');
  assert.equal(summaryPercentage(undefined, undefined), '—');
  assert.equal(summaryPercentage(null, 10), '—');
  assert.equal(summaryPercentage(1, 3000), '<0.1%');
  assert.equal(summaryPercentage(2999, 3000), '>99.9%');
  assert.equal(summaryPercentage(2, 1), '—');
});

test('calendar range retains both years and its day in any local timezone', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['America/Tegucigalpa', 'Pacific/Kiritimati', 'Pacific/Honolulu']) {
      process.env.TZ = zone;
      assert.equal(summaryRangeLabel('2026-12-31', '2027-01-01'), '31 dic 2026 — 1 ene 2027');
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
