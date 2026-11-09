import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparisonScale, duration, metricLeader, percentage } from '../src/services/modelDashboard.js';

test('las barras comparten escala; cero, datos ausentes y porcentajes conservan significado', () => {
  assert.deepEqual(comparisonScale([1000, 2000]), [50, 100]);
  assert.deepEqual(comparisonScale([.2, .6], 1), [20, 60]);
  assert.deepEqual(comparisonScale([0, null]), [0, null]);
  assert.equal(duration(null), 'Sin datos'); assert.equal(duration(0), '0 ms');
  assert.equal(percentage(null), 'Sin datos'); assert.equal(percentage(0), '0 %');
});
test('ganador respeta la dirección del KPI y no declara victoria con datos incompletos', () => {
  const models = [{ label: 'GPT', value: 10 }, { label: 'Gemini', value: 20 }];
  assert.equal(metricLeader(models, 'value', true).label, 'GPT');
  assert.equal(metricLeader(models, 'value').label, 'Gemini');
  assert.equal(metricLeader([{ value: null }, { value: 1 }], 'value'), null);
  assert.equal(metricLeader([{ value: 1 }, { value: 1 }], 'value').tie, true);
});
