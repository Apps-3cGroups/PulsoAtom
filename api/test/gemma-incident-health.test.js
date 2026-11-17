import test from 'node:test';
import assert from 'node:assert/strict';
import { assertGemmaIncidentHealth } from '../src/gemma-incident-health.js';
const profile = { model: 'gemma-synthetic', evaluator: { baseUrl: 'http://gateway.test', portalKey: 'portal-pulso', toolKey: 'gemma' } };
const response = model => ({ ok: true, tool_key: 'gemma', request_uuid: 'health-request', method: 'POST',
  path: '/v1/chat/completions', upstream_status_code: 200, response: { model, choices: [{ finish_reason: 'length', message: { content: '1' } }] } });
test('recovery health uses a bounded synthetic request without changing evaluation configuration', async () => {
 const before = JSON.stringify(profile); let request;
 const result = await assertGemmaIncidentHealth(profile, { token: 'synthetic-token', fetchImpl: async (_url, options) => {
  request = JSON.parse(options.body); return Response.json(response(profile.model));
 } });
 assert.equal(result.requestId, 'health-request'); assert.equal(request.timeout_ms, 30000);
 assert.equal(request.body.max_tokens, 16); assert.equal(request.body.messages.length, 1);
 assert.equal(JSON.stringify(profile), before);
});
test('timeout or a different model blocks recovery without leaking upstream content', async () => {
 for (const fetchImpl of [async () => Response.json({ error: 'PRIVATE_UPSTREAM_TEXT' }, { status: 504 }),
  async () => Response.json(response('other-model'))]) {
  await assert.rejects(assertGemmaIncidentHealth(profile, { token: 'synthetic-token', fetchImpl }), error => {
   assert.equal(error.code, 'GEMMA_PROVIDER_UNAVAILABLE'); assert.doesNotMatch(error.message, /PRIVATE/); return true;
  });
 }
});
