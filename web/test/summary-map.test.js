import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryLanes, compactDaySlots, groupCompactDay, compactMarks } from '../src/services/summaryMap.js';
import { resolveSummaryRange, summaryDayWindow } from '../src/services/summaryDates.js';

test('unassigned assistants are last within each country, preserving the remaining order and every conversation', () => {
  const day = '2026-11-10';
  const countries = [{ code: 'HN' }, { code: 'PA' }];
  const rows = countries.flatMap(country => ['sin-asesor', 'b', 'a'].map((agent, i) => ({
    id: `${country.code}-${agent}`, country: country.code, agent: { id: agent, name: agent },
    displayDate: day, displayAt: `${day}T12:00:0${i}Z`,
  })));
  const before = structuredClone(rows);
  for (const days of [[day], ['2026-11-11', day, '2026-11-09']]) {
    const groups = buildSummaryLanes(rows, countries, days);
    assert.deepEqual(groups.map(g => g.code), ['HN', 'PA']);
    assert.deepEqual(groups.map(g => g.agents.map(a => a.id)), [['b', 'a', 'sin-asesor'], ['b', 'a', 'sin-asesor']]);
    assert.equal(groups.flatMap(g => g.agents.flatMap(a => a.byDay[day])).length, rows.length);
  }
  assert.deepEqual(rows, before);
});

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

test('busy days group without losing or duplicating conversations; quiet days keep the same slot width', () => {
  const slots = compactDaySlots(1080, 30);
  assert.equal(slots, 3);
  const conversations = Array.from({ length: 391 }, (_, i) => ({ id: String(i) }));
  const groups = groupCompactDay(conversations, slots);
  assert.equal(groups.length, slots);
  assert.deepEqual(groups.flat(), conversations);
  assert.ok(Math.max(...groups.map(g => g.length)) - Math.min(...groups.map(g => g.length)) <= 1);
  assert.deepEqual(groupCompactDay(conversations.slice(0, 2), slots), [[conversations[0]], [conversations[1]]]);
  assert.deepEqual(groupCompactDay([], slots), []);
  assert.equal(compactDaySlots(250, 30), 1);
});

test('a grouped cell preserves every visible symbol, including rare human and refuted flags', () => {
  const conversations = [
    { marks: [{ id: 'a', name: 'Crítico', classification: 'critical', effective: true }] },
    { marks: [{ id: 'b', name: 'Humano', classification: 'normal', kind: 'human', origin: 'human', effective: true }] },
    { marks: [{ id: 'c', name: 'Refutado', classification: 'critical', kind: 'refuted', effective: false }] },
    { marks: [{ id: 'd', name: 'Positivo', classification: 'positive', effective: true }] },
  ];
  const filters = { visible: ['critical', 'normal', 'positive', 'refuted', 'human'], classification: 'all' };
  assert.deepEqual(compactMarks(conversations, filters).kinds, ['critical', 'normal', 'refuted', 'human', 'positive']);
  assert.deepEqual(compactMarks(conversations, { ...filters, variable: 'c' }).kinds, ['refuted']);
  assert.deepEqual(compactMarks(conversations, { ...filters, visible: ['human'] }).kinds, ['human']);
  assert.deepEqual(compactMarks(conversations, { ...filters, classification: 'positive' }).kinds, ['positive']);
  assert.deepEqual(compactMarks(conversations, { ...filters, visible: [] }).kinds, []);
});
