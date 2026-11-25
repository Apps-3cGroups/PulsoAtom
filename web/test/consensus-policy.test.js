import test from 'node:test';
import assert from 'node:assert/strict';
import { noVisibleFlagsLabel, unmarkedResultLabel, hasChangedEvaluation, evaluationStatus, evaluationStatusLabel, evaluationCoverage } from '../src/services/flags.js';
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

test('updated source changes presentation without rewriting completed execution or coverage', () => {
  for (const changed of [{ sourceChanged: true }, { evaluation: { sourceChanged: true } }]) {
    const conversation = { evaluated: true, evaluationStatus: 'evaluated', bothModelsComplete: true, suppressedFlags: 2, ...changed };
    assert.equal(hasChangedEvaluation(conversation), true);
    assert.equal(evaluationStatus(conversation), 'evaluated');
    assert.equal(evaluationStatusLabel(conversation), 'Resultados históricos · datos actualizados');
    assert.equal(noVisibleFlagsLabel(conversation), 'Flags históricos no disponibles en esta respuesta');
    assert.deepEqual(evaluationCoverage([conversation]), { not_evaluated: 0, review_pending: 0, partial: 0, evaluated: 1 });
    assert.equal(conversation.bothModelsComplete, true);
  }
  assert.equal(hasChangedEvaluation({ evaluated: false, sourceChanged: true }), false);
  assert.equal(evaluationStatusLabel({ evaluated: false, sourceChanged: true }), 'Sin evaluar');
  assert.equal(evaluationStatusLabel({ evaluated: true, evaluationStatus: 'partial' }), 'Evaluada con incidencias');
  for (const [status, label] of [['partial', 'Evaluada con incidencias'], ['review_pending', 'Falta una revisión de modelo']]) {
    assert.equal(evaluationStatusLabel({ evaluated: true, sourceChanged: true, evaluationStatus: status }), `Resultados históricos · datos actualizados · ${label}`);
  }
});

test('historical agreement is never described as lack of two-model agreement or a current absence', () => {
  const base = { type: 'Flag', method: 'IA', consensusSuppressed: true, result: { status: 'evaluado', value: 1 } };
  const historical = agreement => ({ ...base, result: { ...base.result, comparison: { sourceChanged: true, agreement } } });
  assert.equal(unmarkedResultLabel(historical('agree-positive')), 'Coincidencia histórica de ambos modelos');
  for (const agreement of ['disagree', 'agree-negative', 'incomplete']) {
    assert.equal(unmarkedResultLabel(historical(agreement)), 'Resultado de la evaluación guardada');
  }
  assert.match(unmarkedResultLabel({ ...base, result: { ...base.result, comparison: { agreement: 'disagree' } } }), /Los modelos discrepan/);
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
