import test from 'node:test';
import assert from 'node:assert/strict';
import { runQualityCases, scoreQualityCase } from '../scripts/check-clef-quality.js';
import { qualityCases, selectedVariableIds } from '../scripts/fixtures/clef-quality-cases.js';

const outputFor = fixture => ({ results: selectedVariableIds.map(variableId => {
  const item = fixture.expected[variableId];
  return { variableId, status: item.status, value: item.value, evidence: item.evidenceIds.map(messageId => ({ messageId })) };
}), validationErrors: [] });

test('All zeros fail explicit positive controls and cannot satisfy missing-context case', () => {
  for (const fixture of qualityCases.filter(fixture => fixture.id !== 'synthetic-cordial')) {
    const output = { results: selectedVariableIds.map(variableId => ({ variableId, status: 'evaluado', value: 0, evidence: [] })), validationErrors: [] };
    assert.ok(scoreQualityCase(fixture, output).some(item => !item.pass));
  }
});
test('Detection with the wrong actor evidence fails', () => {
  const fixture = qualityCases[3], output = outputFor(fixture);
  output.results[1].evidence = [{ messageId: fixture.messages[0].id }];
  assert.equal(scoreQualityCase(fixture, output)[1].pass, false);
});
test('Abstention is distinct from a failed variable and from zero', () => {
  const fixture = qualityCases[5], output = outputFor(fixture);
  assert.ok(scoreQualityCase(fixture, output).every(item => item.pass));
  output.validationErrors = [{ variableId: selectedVariableIds[0] }];
  assert.equal(scoreQualityCase(fixture, output)[0].pass, false);
});
test('Expected answers are excluded from input and failures stop without retry', async () => {
  let calls = 0;
  const result = await runQualityCases({ variables: selectedVariableIds.map(id => ({ id, type: 'Flag', method: 'IA' })), evaluator: {
    evaluate: async conversation => {
      calls++;
      assert.deepEqual(Object.keys(conversation).sort(), ['completed', 'id', 'messages']);
      assert.equal(JSON.stringify(conversation).includes('expected'), false);
      throw Object.assign(new Error('private error'), { code: 'AI_TRANSIENT' });
    },
  } });
  assert.equal(calls, 1); assert.equal(result.success, false); assert.equal(result.completedCases, 0);
  assert.equal(JSON.stringify(result).includes('private error'), false);
});
