import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSummaryRange, summaryDayWindow, SUMMARY_PRESETS } from '../src/services/summaryDates.js';
const now = new Date('2026-11-04T01:00:00Z');

test('real periods end yesterday in Honduras and default to three days regardless of the latest loaded day', () => {
  assert.deepEqual(resolveSummaryRange({ mode: 'real', latest: '2026-10-20', timezone: 'America/Tegucigalpa', now }), {
    from: '2026-10-31', to: '2026-11-02', preset: 3, totalDays: 3,
  });
  assert.equal(resolveSummaryRange({ timezone: 'UTC', now }).to, '2026-11-03');
  assert.equal(resolveSummaryRange({ mode: 'real', latest: '2027-01-01', now }).to, '2026-11-02');
});
test('only Ayer, 3 días and 30 días are accepted, including old saved links', () => {
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
  assert.equal(resolveSummaryRange({ mode: 'demo', latest: '2026-02-30', now }).to, '2026-11-02');
});
test('the monthly overview contains all thirty distinct days in one window, newest first', () => {
  const range = resolveSummaryRange({ days: 30, now });
  const window = summaryDayWindow(range);
  assert.equal(window.pageCount, 1);
  assert.equal(window.days.length, 30);
  assert.equal(new Set(window.days).size, 30);
  assert.equal(window.days[0], '2026-11-02');
  assert.equal(window.days.at(-1), '2026-10-04');
});
test('yesterday has one column and invalid windows contain no dates', () => {
  assert.deepEqual(summaryDayWindow(resolveSummaryRange({ days: 1, now })).days, ['2026-11-02']);
  assert.deepEqual(summaryDayWindow({ from: '2026-02-30', to: '2026-03-04' }).days, []);
});

test('Friday November 13 shows Thursday, Wednesday and Tuesday, with today absent from every preset', () => {
  const friday = new Date('2026-11-13T15:00:00Z');
  assert.deepEqual(summaryDayWindow(resolveSummaryRange({ now: friday })).days, ['2026-11-12', '2026-11-11', '2026-11-10']);
  for (const days of SUMMARY_PRESETS) {
    const range = resolveSummaryRange({ days, now: friday });
    const window = summaryDayWindow(range);
    assert.equal(range.to, '2026-11-12');
    assert.equal(window.days.length, days);
    assert.equal(window.days.includes('2026-11-13'), false);
  }
  assert.deepEqual(resolveSummaryRange({ days: 30, now: friday }), { from: '2026-10-14', to: '2026-11-12', preset: 30, totalDays: 30 });
});

test('all presets roll over at Honduras midnight, independently of the browser timezone', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Tegucigalpa', 'Pacific/Kiritimati', 'Pacific/Honolulu']) {
      process.env.TZ = zone;
      for (const days of SUMMARY_PRESETS) {
        assert.equal(resolveSummaryRange({ days, now: new Date('2026-11-13T05:59:59.999Z') }).to, '2026-11-11');
        assert.equal(resolveSummaryRange({ days, now: new Date('2026-11-13T06:00:00.000Z') }).to, '2026-11-12');
      }
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('the previous local calendar day crosses month, leap-year and year boundaries correctly', () => {
  for (const [instant, end, start] of [
    ['2027-01-01T06:00:00Z', '2026-12-31', '2026-12-29'],
    ['2024-03-01T06:00:00Z', '2024-02-29', '2024-02-27'],
    ['2025-03-01T06:00:00Z', '2025-02-28', '2025-02-26'],
    ['2026-09-01T06:00:00Z', '2026-08-31', '2026-08-29'],
  ]) {
    const now = new Date(instant);
    assert.deepEqual(resolveSummaryRange({ days: 3, now }), { from: start, to: end, preset: 3, totalDays: 3 });
    for (const days of SUMMARY_PRESETS) assert.equal(resolveSummaryRange({ days, now }).to, end);
  }
});
