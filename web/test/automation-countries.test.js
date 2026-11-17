import test from 'node:test';
import assert from 'node:assert/strict';
import { automationCountryRows } from '../src/services/automationCountries.js';

const source = [{ code: 'HN', name: 'Honduras' }, { code: 'PA', name: 'Panamá' }, { code: 'CR', name: 'Costa Rica' }];
const draft = [
  { code: 'AF', name: 'Afganistán', enabled: false, paused: false, dailyLimit: 100 },
  { code: 'HN', name: 'Honduras', enabled: true, paused: false, dailyLimit: 200 },
  { code: 'AL', name: 'Albania', enabled: false, paused: false, dailyLimit: 100 },
  { code: 'PA', name: 'Panamá', enabled: true, paused: true, dailyLimit: 75 },
  { code: 'CR', name: 'Costa Rica', enabled: false, paused: false, dailyLimit: 50 },
];

test('saved worldwide entries are hidden while disabled and paused operating countries retain their controls', () => {
  const before = structuredClone(draft);
  const rows = automationCountryRows(draft, source);
  assert.deepEqual(rows.map(c => c.code), ['HN', 'PA', 'CR']);
  assert.equal(rows[1].paused, true);
  assert.equal(rows[2].enabled, false);
  assert.deepEqual(rows.map(c => c.dailyLimit), [200, 75, 50]);
  assert.deepEqual(draft, before);
});

test('search retains the original draft index so changing a quota edits the correct country', () => {
  const copy = structuredClone(draft);
  const [row] = automationCountryRows(copy, source, '  pa  ');
  assert.equal(row.code, 'PA');
  copy[row.index].dailyLimit = 42;
  assert.equal(copy.find(c => c.code === 'PA').dailyLimit, 42);
  assert.equal(copy.find(c => c.code === 'HN').dailyLimit, 200);
  assert.deepEqual(automationCountryRows(copy, source, 'Afganistán'), []);
  assert.deepEqual(automationCountryRows(copy, [], ''), []);
});
