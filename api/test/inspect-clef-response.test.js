import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectClefResponse } from '../scripts/inspect-clef-response.js';
const env = { GATEWAY_BASE_URL: 'https://synthetic.invalid', AGENT_SHARED_TOKEN: 'secret-token' };
test('inspector reads only known audit route, reports shape without content or unrelated runs', async () => {
  let calls = 0;
  const result = await inspectClefResponse({ env, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://synthetic.invalid/v1/admin/tools/gemma/runs?limit=200');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, undefined);
    return Response.json([{ request_uuid: 'unrelated', response: 'UNRELATED_PRIVATE' }, {
      request_uuid: 'c8c48c73-e56e-463f-845a-fb27240af4e3',
      response_json: JSON.stringify({ response: { choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: 'PRIVATE_REASONING' } }] } }),
    }]);
  } });
  assert.equal(calls, 1);
  assert.equal(result.inferenceCount, 0);
  assert.equal(result.found, true);
  assert.equal(result.responseAvailable, true);
  assert.equal(result.shapes.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret-token/);
});
test('access rejection does not read error body or attempt another route', async () => {
  let calls = 0;
  const result = await inspectClefResponse({ env, fetchImpl: async () => { calls++; return new Response('private error', { status: 403 }); } });
  assert.equal(calls, 1);
  assert.equal(result.httpStatus, 403);
  assert.equal(result.found, false);
  assert.doesNotMatch(JSON.stringify(result), /private error/);
});
