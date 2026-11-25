import test from 'node:test';
import assert from 'node:assert/strict';
import { displayedMarks, isDualDetection, historicalDualMarks, displayedVariableKind } from '../src/services/flags.js';
import { summaryMetrics, filterSummaryConversations } from '../src/services/summaryFilters.js';
import { compactMarks } from '../src/services/summaryMap.js';
const historical = { id: 'f', name: 'Hallazgo guardado', kind: 'critical', classification: 'critical',
  historical: true, historicalDualDetected: true, effective: false, dualDetected: false, origin: 'system' };
const base = { id: 'a', evaluated: true, evaluationStatus: 'evaluated', bothModelsComplete: true,
  sourceChanged: true, historicalFlagsAvailable: true, marks: [], historicalMarks: [historical], p1: 0, p2: 0 };
test('historical restoration is display-only, requires API provenance and never duplicates a refutation', () => {
  const original = structuredClone(base);
  assert.deepEqual(displayedMarks(base), [historical]);
  assert.equal(isDualDetection(displayedMarks(base)[0]), false);
  assert.deepEqual(displayedMarks({ ...base, sourceChanged: false }), []);
  assert.deepEqual(displayedMarks({ ...base, historicalFlagsAvailable: undefined }), []);
  assert.deepEqual(displayedMarks({ ...base, historicalMarks: [{ ...historical, historicalDualDetected: false }] }), []);
  const refuted = { ...historical, kind: 'refuted', historical: false, historicalDualDetected: false };
  const reviewed = { ...base, marks: [refuted] };
  assert.deepEqual(displayedMarks(reviewed), [refuted]);
  assert.deepEqual(historicalDualMarks(reviewed), []);
  assert.equal(summaryMetrics([reviewed]).savedAlertCases, 0);
  assert.equal(displayedVariableKind({ historicalAutomaticFlagVisible: true, historicalKind: 'critical', kind: null }), 'critical');
  assert.equal(displayedVariableKind({ historicalAutomaticFlagVisible: true, historicalKind: 'critical', kind: 'refuted' }), 'refuted');
  assert.deepEqual(base, original);
});
test('figure filters, map and saved-result rates share restored flags and count conversations once', () => {
  const cases = [base, { ...base, id: 'b', historicalMarks: [] },
    { ...base, id: 'c', sourceChanged: false, marks: [{ ...historical, historical: false, effective: true, dualDetected: true }], p1: 1 },
    { ...base, id: 'd', historicalFlagsAvailable: false },
    { ...base, id: 'e', evaluationStatus: 'partial', bothModelsComplete: false }];
  const filtered = filterSummaryConversations(cases, ['critical'], { bothComplete: true });
  assert.deepEqual(filtered.map(c => c.id), ['a', 'c']);
  assert.deepEqual(compactMarks([base], { visible: ['critical'], classification: 'all' }), { kinds: ['critical'], names: ['Hallazgo guardado'] });
  const metrics = summaryMetrics(cases);
  assert.equal(metrics.savedResults, 3);
  assert.equal(metrics.savedAlertCases, 2);
  assert.equal(metrics.currentResults, 1);
  assert.equal(metrics.withAlerts, 1, 'operational counts remain separate');
  assert.equal(summaryMetrics([{ ...base, historicalMarks: [historical, { ...historical, id: 'another' }] }]).savedAlertCases, 1);
});
