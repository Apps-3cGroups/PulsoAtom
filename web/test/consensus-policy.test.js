import test from 'node:test';
import assert from 'node:assert/strict';
import { noVisibleFlagsLabel, unmarkedResultLabel } from '../src/services/flags.js';
import { nextReviewAction, canReviewVariable } from '../src/services/reviewPolicy.js';
import { buildActiveBoard } from '../src/services/activeBoard.js';

test('individual detections and incomplete comparison are not described as absent events', () => {
  const variable = { type: 'Flag', method: 'IA', consensusSuppressed: true, result: { status: 'evaluado', value: 1, comparison: { agreement: 'disagree' } } };
  assert.match(unmarkedResultLabel(variable), /modelos discrepan/);
  assert.doesNotMatch(unmarkedResultLabel(variable), /Evento no detectado|^1$/);
  assert.match(unmarkedResultLabel({ ...variable, consensusSuppressed: false, consensusPending: true, result: { status: 'evaluado', value: 0 } }), /sin conclusión conjunta/);
  assert.equal(unmarkedResultLabel({ result: { value: 0 } }), 'Evento no detectado');
  assert.equal(noVisibleFlagsLabel({ suppressedFlags: 3 }), 'Sin flags con coincidencia');
  assert.equal(noVisibleFlagsLabel({ consensusPendingFlags: 3 }), 'Doble revisión pendiente');
});

test('a person raises a suppressed individual detection with evidence instead of refuting a non-published flag', () => {
  const v = { type: 'Flag', enabledInEvaluation: true, automaticFlagVisible: false, result: { status: 'evaluado', value: 1 } };
  assert.equal(canReviewVariable({ evaluated: true }, v), true);
  assert.equal(nextReviewAction(v), 'levantar');
  assert.equal(nextReviewAction({ ...v, automaticFlagVisible: true }), 'refutar');
  assert.equal(nextReviewAction({ ...v, review: { action: 'levantar' } }), 'deshacer');
  assert.equal(canReviewVariable({ evaluated: true }, { ...v, type: 'Métrica' }), false);
});

test('country board counts missing second reviews as pending without inventing flags', () => {
  const c = { id: 'demo', country: 'HN', agent: { id: '1', name: 'Demo' }, startedAt: '2026-11-05', evaluated: true, critical: 0, normal: 0, positive: 0, marks: [], consensusPendingFlags: 2 };
  const group = buildActiveBoard([c], 'HN')[0];
  assert.equal(group.flagged, 0);
  assert.equal(group.pending, 1);
});
