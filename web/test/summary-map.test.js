import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryLanes } from '../src/services/summaryMap.js';
import { resolveSummaryRange, summaryDayWindow } from '../src/services/summaryDates.js';

test('a dense month preserves every conversation once, including last-day and pending cases', () => {
  const days = summaryDayWindow(resolveSummaryRange({ days: 30, now: new Date('2026-11-09T16:00:00Z') })).days;
  const countries = [{ code: 'HN' }, { code: 'CR' }];
  const conversations = countries.flatMap(country => days.flatMap((day, index) => Array.from({ length: 20 }, (_, i) => ({
    id: `${country.code}-${index}-${i}`, country: country.code, agent: { id: String(i % 4), name: 'Nombre compartido' },
    evaluated: i % 2 === 0, displayDate: day, displayAt: `${day}T16:${String(i).padStart(2, '0')}:00Z`,
  }))));
  const original = structuredClone(conversations);
  const groups = buildSummaryLanes(conversations, countries, days);
  const displayed = groups.flatMap(g => g.agents.flatMap(a => days.flatMap(day => a.byDay[day])));
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(g => g.agents.length), [4, 4]);
  assert.equal(displayed.length, 1200);
  assert.equal(new Set(displayed.map(c => c.id)).size, 1200);
  assert.deepEqual(conversations, original);
  assert.ok(groups.every(g => g.agents.every(a => a.byDay[days.at(-1)].length === 5)));
  assert.ok(groups[0].agents[0].byDay[days[0]][0].displayAt.endsWith('16:16:00Z'));
});
