import test from 'node:test';
import assert from 'node:assert/strict';
import { figureKinds, filterSummaryConversations, summaryMetrics, selectedCountries, selectedFigures } from '../src/services/summaryFilters.js';
const mark = (id, kind, extras = {}) => ({ id, kind, classification: kind, effective: true, name: id, ...extras });
const rows = [
  { id: 'critical', evaluated: true, p1: 1, originalAlerts: 1, marks: [mark('a', 'critical')] },
  { id: 'human', evaluated: true, p2: 1, human: 1, originalAlerts: 1, marks: [mark('b', 'human', { classification: 'normal', origin: 'human' })] },
  { id: 'refuted', evaluated: true, refuted: 1, originalAlerts: 1, marks: [mark('c', 'refuted', { classification: 'critical', effective: false })] },
  { id: 'positive', evaluated: true, positive: 1, marks: [mark('d', 'positive')] },
  { id: 'pending', evaluated: false, marks: [] }, { id: 'clear', evaluated: true, marks: [] },
];
test('figures filter the same population used by metrics, preserving human/refuted meanings', () => {
  assert.equal(filterSummaryConversations(rows, figureKinds).length, 6);
  assert.deepEqual(filterSummaryConversations(rows, []).map(c => c.id), []);
  assert.deepEqual(filterSummaryConversations(rows, ['critical']).map(c => c.id), ['critical']);
  assert.deepEqual(filterSummaryConversations(rows, ['human', 'refuted']).map(c => c.id), ['human', 'refuted']);
  assert.deepEqual(filterSummaryConversations(rows, ['normal'], 'b').map(c => c.id), ['human']);
  assert.deepEqual(filterSummaryConversations(rows, ['normal'], 'a'), []);
  const metrics = summaryMetrics(filterSummaryConversations(rows, ['critical', 'normal']));
  assert.equal(metrics.total, 2); assert.equal(metrics.withAlerts, 2); assert.equal(metrics.alertPercent, 100);
});
test('country URL compatibility, all countries, explicit empty figures and restored selection', () => {
  const countries = [{ code: 'HN' }, { code: 'PA' }];
  assert.deepEqual(selectedCountries(new URLSearchParams('country=HN'), countries), ['HN']);
  assert.deepEqual(selectedCountries(new URLSearchParams('countries=PA,HN,PA'), countries), ['HN', 'PA']);
  assert.deepEqual(selectedCountries(new URLSearchParams(), countries), []);
  assert.deepEqual(selectedFigures(new URLSearchParams()), figureKinds);
  assert.deepEqual(selectedFigures(new URLSearchParams('figures=')), []);
  assert.deepEqual(selectedFigures(new URLSearchParams('figures=human,refuted')), ['human', 'refuted']);
});
