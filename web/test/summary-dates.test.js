import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSummaryRange, summaryDayWindow, SUMMARY_PRESETS } from '../src/services/summaryDates.js';
const now = new Date('2026-11-04T01:00:00Z');

test('real periods end today in the portal timezone and default to three days', () => {
  assert.deepEqual(resolveSummaryRange({ mode: 'real', latest: '2026-10-20', timezone: 'America/Tegucigalpa', now }), {
    from: '2026-11-01', to: '2026-11-03', preset: 3, totalDays: 3,
  });
  assert.equal(resolveSummaryRange({ timezone: 'UTC', now }).to, '2026-11-04');
});
test('only Hoy, 3 días and 30 días are accepted, including old saved links', () => {
  assert.deepEqual(SUMMARY_PRESETS, [1, 3, 30]);
  for (const days of SUMMARY_PRESETS) assert.equal(resolveSummaryRange({ days, now }).totalDays, days);
  for (const days of [0, 2, 4, 7, 14, -7, 7.5, 'invalid', 999]) assert.equal(resolveSummaryRange({ days, now }).preset, 3);
  assert.equal(resolveSummaryRange({ from: '2024-01-01', to: '2025-12-31', now }).totalDays, 3);
});
test('demo periods remain deterministic, including leap dates and year boundaries', () => {
  assert.deepEqual(resolveSummaryRange({ mode: 'demo', latest: '2026-01-02', days: 3, now }), {
    from: '2025-12-31', to: '2026-01-02', preset: 3, totalDays: 3,
  });
  assert.equal(resolveSummaryRange({ mode: 'demo', latest: '2024-03-01', days: 3, now }).from, '2024-02-28');
  assert.equal(resolveSummaryRange({ mode: 'demo', latest: '2026-02-30', now }).to, '2026-11-03');
});
test('the monthly overview contains all thirty distinct days in one window, newest first', () => {
  const range = resolveSummaryRange({ days: 30, now });
  const window = summaryDayWindow(range);
  assert.equal(window.pageCount, 1);
  assert.equal(window.days.length, 30);
  assert.equal(new Set(window.days).size, 30);
  assert.equal(window.days[0], '2026-11-03');
  assert.equal(window.days.at(-1), '2026-10-05');
});
test('today has one column and invalid windows contain no dates', () => {
  assert.deepEqual(summaryDayWindow(resolveSummaryRange({ days: 1, now })).days, ['2026-11-03']);
  assert.deepEqual(summaryDayWindow({ from: '2026-02-30', to: '2026-03-04' }).days, []);
});
