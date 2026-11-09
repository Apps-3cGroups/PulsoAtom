import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSummaryRange, summaryDayWindow } from '../src/services/summaryDates.js';

const now = new Date('2026-11-04T01:00:00Z');

test('real summary uses the portal calendar today instead of stale activity data', () => {
  assert.deepEqual(resolveSummaryRange({ mode: 'real', latest: '2026-10-20', timezone: 'America/Tegucigalpa', now }), {
    from: '2026-10-28', to: '2026-11-03', preset: 7, totalDays: 7,
  });
  assert.equal(resolveSummaryRange({ mode: 'real', timezone: 'UTC', now }).to, '2026-11-04');
});

test('demo stays anchored to its latest activity date and shortcuts cross years', () => {
  assert.deepEqual(resolveSummaryRange({ mode: 'demo', latest: '2026-01-03', now }), {
    from: '2025-12-28', to: '2026-01-03', preset: 7, totalDays: 7,
  });
  assert.deepEqual(resolveSummaryRange({ mode: 'demo', latest: '2026-01-03', days: '4', now }), {
    from: '2025-12-31', to: '2026-01-03', preset: 4, totalDays: 4,
  });
});

test('only the five shortcuts are accepted; invalid demo anchor falls back to today', () => {
  for (const days of [1, 4, 7, 14, 30]) assert.equal(resolveSummaryRange({ days, now }).totalDays, days);
  for (const days of [0, 2, -7, 7.5, 'invalid', 999]) assert.equal(resolveSummaryRange({ days, now }).preset, 7);
  assert.equal(resolveSummaryRange({ mode: 'demo', latest: '2026-02-30', now }).to, '2026-11-03');
});

test('custom ranges preserve both endpoints, including one day and leap day', () => {
  assert.deepEqual(resolveSummaryRange({ from: '2024-02-29', to: '2024-02-29', days: 30, now }), {
    from: '2024-02-29', to: '2024-02-29', preset: null, totalDays: 1,
  });
  assert.deepEqual(resolveSummaryRange({ from: '2023-12-31', to: '2024-03-01', now }), {
    from: '2023-12-31', to: '2024-03-01', preset: null, totalDays: 62,
  });
});

test('invalid or incomplete custom dates fall back to seven days instead of silently widening the range', () => {
  const expected = { from: '2026-10-28', to: '2026-11-03', preset: 7, totalDays: 7 };
  for (const range of [
    { from: '2026-02-29', to: '2026-03-04' },
    { from: '2026-02-30', to: '2026-03-04' },
    { from: '2026-11-04', to: '2026-11-03' },
    { from: '2026-11-01' }, { to: '2026-11-03' },
    { from: '2026-1-01', to: '2026-11-03' },
    { from: '0000-01-01', to: '2026-11-03' },
    { from: '2026-11-01', to: '10000-01-01' },
  ]) assert.deepEqual(resolveSummaryRange({ ...range, days: 30, now }), expected);
});

test('a long range has at most 31 columns per window, newest first, without losing range totals', () => {
  const range = { from: '2023-12-31', to: '2024-03-01' };
  const first = summaryDayWindow(range);
  const second = summaryDayWindow({ ...range, page: 2 });
  assert.deepEqual({ totalDays: first.totalDays, page: first.page, pageCount: first.pageCount }, { totalDays: 62, page: 1, pageCount: 2 });
  assert.equal(first.days.length, 31);
  assert.equal(first.days[0], '2024-03-01');
  assert.equal(first.days.at(-1), '2024-01-31');
  assert.equal(second.days[0], '2024-01-30');
  assert.equal(second.days.at(-1), '2023-12-31');
  assert.equal(new Set([...first.days, ...second.days]).size, 62);
});

test('window clamps pages and caps the requested page size at 31', () => {
  const range = { from: '2026-01-01', to: '2026-02-02' };
  const last = summaryDayWindow({ ...range, page: 99 }, 100);
  assert.deepEqual(last, { days: ['2026-01-02', '2026-01-01'], totalDays: 33, page: 2, pageCount: 2 });
  for (const page of [0, -2, NaN, 1.5]) assert.equal(summaryDayWindow({ ...range, page }).page, 1);
  assert.equal(summaryDayWindow({ ...range, page: '2' }).page, 2);
  assert.equal(summaryDayWindow(range, 0).days.length, 31);
  assert.equal(summaryDayWindow(range, 7).pageCount, 5);
});

test('calendar limits through year 9999 remain bounded without materializing the complete range', () => {
  const range = resolveSummaryRange({ from: '0001-01-01', to: '9999-12-31', now });
  const first = summaryDayWindow(range);
  const last = summaryDayWindow({ ...range, page: first.pageCount });
  assert.equal(range.totalDays, 3652059);
  assert.equal(first.days[0], '9999-12-31');
  assert.equal(first.days.length, 31);
  assert.equal(last.days.at(-1), '0001-01-01');
  assert.ok(last.days.length <= 31);
});

test('one-day windows and invalid windows have deterministic boundaries', () => {
  assert.deepEqual(summaryDayWindow({ from: '2026-11-03', to: '2026-11-03' }), { days: ['2026-11-03'], totalDays: 1, page: 1, pageCount: 1 });
  assert.deepEqual(summaryDayWindow({ from: '2026-02-30', to: '2026-03-04' }), { days: [], totalDays: 0, page: 1, pageCount: 0 });
});
