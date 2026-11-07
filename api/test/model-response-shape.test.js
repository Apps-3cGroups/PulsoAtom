import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeModelResponse } from '../src/services/modelResponseShape.js';
const payload = message => ({ model: 'PRIVATE_MODEL', choices: [{ finish_reason: 'stop', message }] });

test('distinguishes empty, missing, null, object and array content without returning text', () => {
  assert.equal(summarizeModelResponse(payload({})).content.type, 'missing');
  assert.equal(summarizeModelResponse(payload({ content: null })).content.type, 'null');
  assert.deepEqual(summarizeModelResponse(payload({ content: '' })).content, { type: 'string', characters: 0, textParts: 0 });
  assert.equal(summarizeModelResponse(payload({ content: { PRIVATE_KEY: 'PRIVATE_TEXT' } })).content.type, 'object');
  const summary = summarizeModelResponse(payload({ content: [{ type: 'text', text: 'PRIVATE_TEXT' }, 'SECOND_PRIVATE_TEXT', { type: 'image_url', image_url: 'PRIVATE_URL' }] }));
  assert.deepEqual(summary.content, { type: 'array', characters: 31, textParts: 2, parts: 3 });
  assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
});

test('recognizes reasoning-only structured JSON by booleans without exposing reasoning or keys', () => {
  const summary = summarizeModelResponse(payload({ content: null,
    reasoning_content: JSON.stringify({ results: { SECRET_VARIABLE: 'SECRET_REASON' } }),
    reasoning: 'PRIVATE_CHAIN_OF_THOUGHT', tool_calls: [{ function: { name: 'SECRET_TOOL', arguments: 'PRIVATE_ARGUMENTS' } }], refusal: 'SECRET_REFUSAL' }));
  assert.equal(summary.choicesCount, 1);
  assert.equal(summary.contentIsJsonObject, false);
  assert.equal(summary.reasoningIsJsonObject, true);
  assert.equal(summary.reasoningHasResults, true);
  assert.equal(summary.toolCallsCount, 1);
  assert.equal(summary.refusalPresent, true);
  assert.equal(summary.finishReason, 'stop');
  assert.ok(!JSON.stringify(summary).includes('SECRET'));
  assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
});

test('JSON diagnostics do not validate evaluations or forward unexpected fields and finish reasons', () => {
  const summary = summarizeModelResponse({ arbitrary: 'SECRET', choices: [{ finish_reason: 'PRIVATE_REASON',
    message: { content: '{"results":null,"SECRET":"PRIVATE"}', reasoning_content: '[]', reasoning: '{invalid', refusal: null } }] });
  assert.equal(summary.contentIsJsonObject, true);
  assert.equal(summary.contentHasResults, true);
  assert.equal(summary.reasoningIsJsonObject, false);
  assert.equal(summary.finishReason, null);
  assert.equal(summary.refusalPresent, false);
  assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
  assert.equal(summarizeModelResponse(null).choicesCount, 0);
});
