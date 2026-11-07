import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkClefResponseModes, shouldTryPromptJson } from '../scripts/check-clef-response-modes.js';
const baseline = { format: 1, model: 'clef-flash', conversationId: '6135', summary: { errorCode: 'INVALID_AI_RESULT' },
  context: { sourceHash: 'original-hash' }, gemmaReference: { evaluationId: 'gemma-evaluation-id' } };
const empty = { success: false, errorCode: 'INVALID_AI_RESULT', sourceUnchanged: true, configurationUnchanged: true,
  protocol: { gatewayHttpStatus: 200, upstreamStatus: 200, actualModel: 'clef-flash', responseShape: { choicesCount: 1, finishReason: 'stop', refusalPresent: false,
    toolCallsCount: 0, content: { type: 'string', characters: 0 } } } };
test('alternative is only permitted for a completed empty final output, not technical failures or changed content', () => {
  assert.equal(shouldTryPromptJson(empty), true);
  assert.equal(Boolean(shouldTryPromptJson({ ...empty, protocol: { ...empty.protocol, upstreamStatus: 202 } })), false);
  for (const replacement of [{ success: true }, { errorCode: 'AI_UNAVAILABLE' }, { sourceUnchanged: false }, { configurationUnchanged: false }]) {
    assert.equal(Boolean(shouldTryPromptJson({ ...empty, ...replacement })), false);
  }
  for (const change of [{ finishReason: 'length' }, { refusalPresent: true }, { choicesCount: 2 }, { toolCallsCount: 1 },
    { content: { type: 'array', characters: 50 } }]) {
    assert.equal(Boolean(shouldTryPromptJson({ ...empty, protocol: { ...empty.protocol,
      responseShape: { ...empty.protocol.responseShape, ...change } } })), false);
  }
});
test('diagnosis runs at most two explicit modes on the one fixed conversation', async () => {
  const calls = [];
  const result = await checkClefResponseModes({ baseline, runProbe: async options => {
    calls.push(options);
    return calls.length === 1 ? empty : { success: true };
  } });
  assert.equal(result.success, true);
  assert.equal(result.conversationId, '6135');
  assert.deepEqual(calls.map(c => c.requestMode), ['schema', 'prompt-json']);
  assert.notEqual(calls[0].outputPath, calls[1].outputPath);
  assert.equal(calls[0].reader, calls[1].reader);
});
test('no second call after a successful original mode or a timeout; a different chat is rejected before evaluation', async () => {
  for (const answer of [{ success: true }, { ...empty, errorCode: 'AI_UNAVAILABLE' }]) {
    let calls = 0;
    await checkClefResponseModes({ baseline, runProbe: async () => { calls++; return answer; } });
    assert.equal(calls, 1);
  }
  await assert.rejects(checkClefResponseModes({ baseline: { ...baseline, conversationId: 'other-chat' },
    runProbe: () => assert.fail('Unexpected inference') }), error => error.code === 'INVALID_SOURCE');
});
