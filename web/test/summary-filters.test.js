import test from 'node:test';
import assert from 'node:assert/strict';
import { figureKinds, filterSummaryConversations, summaryMetrics, selectedCountries, selectedFigures, cleanOverviewParams, hasModelCoverage, bothModelsComplete } from '../src/services/summaryFilters.js';
const mark = (id, kind, extras = {}) => ({ id, kind, classification: kind, effective: true, name: id, ...extras });
const rows = [
  { id: 'critical', evaluated: true, p1: 1, originalAlerts: 1, marks: [mark('a', 'critical')] },
  { id: 'human', evaluated: true, p2: 1, human: 1, originalAlerts: 1, marks: [mark('b', 'human', { classification: 'normal', origin: 'human' })] },
  { id: 'refuted', evaluated: true, refuted: 1, originalAlerts: 1, marks: [mark('c', 'refuted', { classification: 'critical', effective: false })] },
  { id: 'positive', evaluated: true, positive: 1, marks: [mark('d', 'positive')] },
  { id: 'pending', evaluated: false, marks: [] }, { id: 'clear', evaluated: true, marks: [] },
];
test('figures filter the same population used by metrics, preserving human/refuted meanings', () => {
  assert.equal(filterSummaryConversations(rows, figureKinds).length, 5);
  assert.deepEqual(filterSummaryConversations(rows, []).map(c => c.id), []);
  assert.deepEqual(filterSummaryConversations(rows, ['critical']).map(c => c.id), ['critical']);
  assert.deepEqual(filterSummaryConversations(rows, ['human', 'refuted']).map(c => c.id), ['human', 'refuted']);
  assert.deepEqual(filterSummaryConversations(rows, ['normal']).map(c => c.id), ['human']);
  const metrics = summaryMetrics(filterSummaryConversations(rows, ['critical', 'normal']));
  assert.equal(metrics.total, 2); assert.equal(metrics.withAlerts, 2); assert.equal(metrics.alertPercent, 100);
});
test('pending visibility distinguishes missing model reviews from saved partial results and updates metrics', () => {
  const conversations = [
    { ...rows[0], id: 'complete', evaluationStatus: 'evaluated' },
    { ...rows[0], id: 'partial', evaluationStatus: 'partial', evaluationErrors: 1 },
    { ...rows[0], id: 'one-model', evaluationStatus: 'review_pending' },
    { ...rows[0], id: 'legacy-one-model', consensusPendingFlags: 1 },
    { ...rows[4], id: 'unreviewed', evaluationStatus: 'not_evaluated' },
  ];
  const shown = filterSummaryConversations(conversations, figureKinds);
  assert.deepEqual(shown.map(c => c.id), ['complete', 'partial']);
  assert.equal(summaryMetrics(shown).total, 2);
  assert.equal(summaryMetrics(shown).withAlerts, 1);
  assert.equal(summaryMetrics(shown).currentResults, 1);
  assert.deepEqual(filterSummaryConversations(conversations, ['critical']).map(c => c.id), ['complete', 'partial']);
  assert.deepEqual(filterSummaryConversations(conversations, ['positive']), []);
  assert.deepEqual(filterSummaryConversations(conversations, []), []);
});
test('historical completed pairs stay visible without diluting or inflating current flag rates', () => {
  const base = { evaluated: true, evaluationStatus: 'evaluated', bothModelsComplete: true, marks: [], p1: 0, p2: 0 };
  const cases = [
    { ...base, id: 'current-alert', p1: 1 },
    { ...base, id: 'current-negative' },
    { ...base, id: 'hidden-historical-flags', sourceChanged: true, suppressedFlags: 4 },
    { ...base, id: 'historical-human-mark', sourceChanged: true, p2: 1, positive: 1, human: 1 },
  ];
  const shown = filterSummaryConversations(cases, figureKinds, { bothComplete: true });
  assert.equal(shown.length, 4, 'saved pairs remain available for inspection');
  const metrics = summaryMetrics(shown);
  assert.equal(metrics.total, 4);
  assert.equal(metrics.sourceChanged, 2);
  assert.equal(metrics.currentResults, 2);
  assert.equal(metrics.withAlerts, 1);
  assert.equal(metrics.alertPercent, 50);
  assert.equal(metrics.withPositives, 0);
  assert.equal(metrics.human, 0);
  const historical = summaryMetrics(shown.filter(row => row.sourceChanged));
  assert.equal(historical.total, 2);
  assert.equal(historical.currentResults, 0);
  assert.equal(historical.alertPercent, null, 'historical rows cannot imply a zero-percent finding');
});
test('both-model coverage requires complete Clef and Gemma and keeps clean conversations and valid abstentions', () => {
  const base = { id: 'complete', evaluated: true, evaluationStatus: 'evaluated', marks: [], bothModelsComplete: true,
    modelReviews: [{ profileId: 'clef-local', status: 'completed', abstainedCount: 1 }, { profileId: 'gemma-local', status: 'completed', abstainedCount: 1 }] };
  const cases = [base,
    { ...base, id: 'server-verified', modelReviews: undefined, bothModelsComplete: true },
    { ...base, id: 'one-model', bothModelsComplete: false, modelReviews: base.modelReviews.slice(0, 1) },
    { ...base, id: 'partial', evaluationStatus: 'partial' },
    { ...base, id: 'pending', bothModelsComplete: false, modelReviews: [base.modelReviews[0], { profileId: 'gemma-local', status: 'running' }] },
    { ...base, id: 'duplicate', bothModelsComplete: false, modelReviews: [base.modelReviews[0], base.modelReviews[0]] },
    { ...base, id: 'missing-coverage', bothModelsComplete: undefined, modelReviews: undefined },
    { ...base, id: 'legacy-status-labels', bothModelsComplete: undefined },
    { ...base, id: 'server-incomplete', bothModelsComplete: false },
  ];
  assert.deepEqual(filterSummaryConversations(cases, figureKinds, { bothComplete: true }).map(item => item.id), ['complete', 'server-verified']);
  assert.equal(bothModelsComplete({ ...base, evaluationStatus: 'partial', bothModelsComplete: true }), false);
  assert.equal(hasModelCoverage(cases.find(item => item.id === 'missing-coverage')), false);
  assert.equal(hasModelCoverage(cases.find(item => item.id === 'legacy-status-labels')), false);
  assert.equal(hasModelCoverage(cases.find(item => item.id === 'server-incomplete')), true);
});
test('legacy hidden filters are removed without losing country, period or exception selection', () => {
  const original = new URLSearchParams('days=30&country=HN&figures=human,refuted&pending=1&variable=old&classification=critical&agreement=both');
  const cleaned = cleanOverviewParams(original);
  assert.equal(cleaned.get('countries'), 'HN');
  assert.equal(cleaned.get('days'), '30');
  assert.equal(cleaned.get('figures'), 'human,refuted');
  for (const key of ['country', 'pending', 'variable', 'classification', 'agreement']) assert.equal(cleaned.has(key), false);
  assert.equal(original.get('pending'), '1');
  assert.equal(cleanOverviewParams(new URLSearchParams('countries=PA&country=HN&figures=')).get('countries'), 'PA');
  assert.equal(cleanOverviewParams(new URLSearchParams('figures=')).has('figures'), true);
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
