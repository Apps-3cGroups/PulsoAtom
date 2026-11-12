import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryRangeLabel } from '../src/services/summaryPresentation.js';

test('summary range omits connecting words and repeats no date for today', () => {
  assert.equal(summaryRangeLabel('2026-11-09', '2026-11-11'), '9 nov 2026 — 11 nov 2026');
  assert.equal(summaryRangeLabel('2026-11-11', '2026-11-11'), '11 nov 2026');
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
