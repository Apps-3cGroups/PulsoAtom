import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classificationOf, dualMarks, flagCount, flagVariables, metricValue } from '../src/services/flags.js';
import { buildActiveBoard, visibleBoardMarks } from '../src/services/activeBoard.js';

test('historical classifications remain independent of new catalog definitions and non-flags stay out of filters', () => {
  const variables = [{ id: 'old', type: 'Flag', mark: 'P2' }, { id: 'new', type: 'Flag', mark: 'Crítico' }, { id: 'good', type: 'Flag', mark: '+' }, { id: 'time', type: 'Métrica', mark: '' }, { id: 'context', type: 'Descriptor', mark: '' }];
  assert.deepEqual(flagVariables(variables).map(classificationOf), ['normal', 'critical', 'positive']);
  assert.equal(classificationOf(variables[3]), null);
  assert.equal(classificationOf({ kind: 'human', classification: 'positive' }), 'positive');
});

test('dual detection respects the same selected variable, and a refuted agreement is no longer current', () => {
  const c = { marks: [
    { id: 'good', classification: 'positive', kind: 'positive', effective: true, comparison: { agreement: 'agree-positive', detections: 2, votes: 2 } },
    { id: 'refuted', classification: 'critical', kind: 'refuted', effective: false, comparison: { agreement: 'agree-positive', detections: 2, votes: 2 } },
    { id: 'blocked', classification: 'critical', kind: 'critical', effective: true, dualDetected: false, comparison: { agreement: 'agree-positive', detections: 2, votes: 2 } },
    { id: 'pending', classification: 'critical', kind: 'critical', effective: true, comparison: { agreement: 'incomplete', detections: 1 } },
  ] };
  assert.deepEqual(dualMarks(c).map(m => m.id), ['good']);
  assert.equal(dualMarks(c, 'pending').length, 0);
  assert.equal(flagCount(c, 'positive'), 1);
  assert.equal(flagCount(c, 'critical'), 2);
});

test('positive human events remain visible without counting as attention flags in the country board', () => {
  const c = { id: 'positive', country: 'HN', agent: { id: '1', name: 'Ana' }, startedAt: '2026-11-03', evaluated: true, critical: 0, normal: 0, positive: 1, human: 1, marks: [{ id: 'good', kind: 'human', classification: 'positive', origin: 'human', effective: true }] };
  assert.equal(visibleBoardMarks(c).length, 1);
  assert.equal(buildActiveBoard([c], 'HN')[0].flagged, 0);
});

test('metric missing and failed results cannot render as zero; real zero remains available', () => {
  assert.equal(metricValue({ result: { status: 'evaluado', value: 0 } }), 0);
  assert.equal(metricValue({ result: { status: 'no_evaluado', value: null } }), null);
  assert.equal(metricValue({ result: { status: 'evaluado', value: Infinity } }), null);
  assert.equal(metricValue({ result: { status: 'evaluado', value: '0' } }), null);
});

test('a conversation with only deterministic results remains visibly pending when flags are incomplete', () => {
  const base = { country: 'HN', agent: { id: '1', name: 'Ana' }, startedAt: '2026-11-03', evaluated: true, critical: 0, normal: 0, positive: 0, marks: [] };
  const groups = buildActiveBoard([{ ...base, id: 'complete' }, { ...base, id: 'partial', evaluationIncomplete: true, pendingFlags: 4 }], 'HN');
  assert.equal(groups[0].pending, 1);
  assert.equal(groups[0].flagged, 0);
  assert.deepEqual(groups[0].conversations.map(c => c.id), ['partial', 'complete']);
});
