import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationStatus, evaluationStatusLabel, evaluationPending, needsModelReview, evaluationCoverage } from '../src/services/flags.js';
import { modelReviewVariables, modelReviewStatusLabel, modelResultStatus } from '../src/services/modelReview.js';
import { buildActiveBoard } from '../src/services/activeBoard.js';

test('finished model reviews remain evaluated when some variables lack context', () => {
  const c = { evaluated: true, evaluationStatus: 'evaluated', unavailableFlags: 4, evaluationIncomplete: true, consensusPendingFlags: 3 };
  assert.equal(evaluationStatus(c), 'evaluated');
  assert.equal(evaluationStatusLabel(c), 'Evaluada');
  assert.equal(evaluationPending(c), false);
  assert.equal(needsModelReview(c), false);
});

test('technical incidents are evaluated, distinct from missing reviews and no evaluation', () => {
  const conversations = [
    { evaluated: true, evaluationStatus: 'evaluated', unavailableFlags: 3 },
    { evaluated: true, evaluationStatus: 'partial', evaluationErrors: 2 },
    { evaluated: true, evaluationStatus: 'review_pending' },
    { evaluated: false, evaluationStatus: 'not_evaluated' },
  ];
  assert.equal(evaluationStatusLabel(conversations[1]), 'Evaluada con incidencias');
  assert.equal(evaluationPending(conversations[1]), false);
  assert.deepEqual(evaluationCoverage(conversations), { evaluated: 1, partial: 1, review_pending: 1, not_evaluated: 1 });
  const board = buildActiveBoard(conversations.map((c, i) => ({ ...c, id: String(i), country: 'HN', agent: { id: 'a', name: 'Demo' }, startedAt: '2026-11-05', marks: [] })), 'HN');
  assert.equal(board[0].conversations.length, 4);
  assert.equal(board[0].pending, 2);
  assert.equal(board[0].flagged, 0);
});

test('comparison includes absent and abstained AI flags without treating shared metrics as votes', () => {
  const make = (id, agreement, extra = {}) => ({ id, name: id, enabledInEvaluation: true, type: 'Flag', method: 'IA', result: { comparison: { agreement, cells: [{ profileId: 'gemma' }, { profileId: 'clef' }] } }, ...extra });
  const variables = [make('absent', 'agree-negative'), make('pending', 'incomplete'), make('same', 'agree-positive'), make('different', 'disagree'), make('metric', 'agree-positive', { type: 'Métrica' }), make('code', 'agree-positive', { method: 'Cálculo' }), make('inactive', 'agree-positive', { enabledInEvaluation: false })];
  const before = structuredClone(variables);
  assert.deepEqual(modelReviewVariables(variables).map(v => v.id), ['same', 'different', 'pending', 'absent']);
  assert.deepEqual(variables, before);
});

test('saved response labels distinguish abstention, absence, detection and technical failure', () => {
  assert.equal(modelResultStatus({ result: { status: 'evaluado', value: 0 } }), 'No detecta el evento');
  assert.equal(modelResultStatus({ result: { status: 'evaluado', value: 1 } }), 'Detecta el evento');
  assert.equal(modelResultStatus({ result: { status: 'no_evaluado', value: null } }), 'Sin contexto suficiente');
  assert.equal(modelResultStatus({ result: { status: 'no_evaluado', error: { code: 'AI_TRANSIENT' } } }), 'Error de evaluación');
  assert.equal(modelResultStatus({ status: 'pending', result: null }), 'Sin resultado guardado');
  assert.equal(modelReviewStatusLabel('partial'), 'Revisión terminada · con incidencias');
});
