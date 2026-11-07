import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClefFlashCheck } from '../scripts/check-clef-flash.js';

const env = { GATEWAY_BASE_URL: 'http://gateway.synthetic:9000', AGENT_SHARED_TOKEN: 'private-synthetic-token', GEMMA_TOOL_KEY: 'gemma', CLEF_TOOL_KEY: 'qwen' };
const requestId = '00000000-1111-4222-8333-444444444444';
const response = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
function fixture(models) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/tools')) return response({ tools: [...Object.keys(models).map(key => ({ key, status: 'active' })), { key: 'unrelated', status: 'active' }] });
    const invocation = JSON.parse(options.body), toolKey = url.match(/\/tools\/([^/]+)\/invoke$/)[1];
    const envelope = { ok: true, tool_key: toolKey, method: invocation.method, path: invocation.path, upstream_status_code: 200, request_uuid: requestId };
    if (invocation.method === 'GET') return response({ ...envelope, response: { data: models[toolKey].map(id => ({ id })) } });
    return response({ ...envelope, response: { model: invocation.body.model,
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] } });
  };
  return { calls, run: () => runClefFlashCheck({ env, fetchImpl }) };
}
const inferences = calls => calls.filter(call => call.options.body && JSON.parse(call.options.body).method === 'POST');

test('Clef Flash discovery chooses the exact published gemma target and runs at most one minimal inference', async () => {
  for (const models of [
    { gemma: ['provider/clef_flash', 'cloudflare_clef'], qwen: ['clef-flash'], clef: ['other'] },
    { gemma: ['cloudflare_clef'], qwen: ['provider/clef-flash'] },
  ]) {
    const { run, calls } = fixture(models);
    const result = await run();
    const target = models.gemma.includes('provider/clef_flash') ? { toolKey: 'gemma', model: 'provider/clef_flash' } : { toolKey: 'qwen', model: 'provider/clef-flash' };
    assert.equal(result.success, true);
    assert.deepEqual(result.target, target);
    assert.equal(inferences(calls).length, 1);
    assert.equal(result.result.stages.length, 1);
    assert.equal(result.result.stages[0].stage, 'minimal');
    const request = inferences(calls)[0];
    assert.ok(request.url.endsWith(`/v1/tools/${target.toolKey}/invoke`));
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.body.model, target.model);
    assert.equal(payload.body.max_tokens, 64);
    assert.equal(payload.body.response_format, undefined);
    assert.equal(calls.filter(call => call.options.body && JSON.parse(call.options.body).method === 'GET').length, Object.keys(models).length);
    assert.ok(!JSON.stringify(result).includes(env.AGENT_SHARED_TOKEN));
    assert.ok(!JSON.stringify(result).includes('gateway.synthetic'));
  }
});

test('ambiguous, absent or unsafe catalog targets never run inference', async () => {
  for (const models of [
    { gemma: ['vendor-a/clef-flash', 'vendor-b/clef_flash'], qwen: ['clef-flash'] },
    { gemma: ['other'], qwen: ['clef-flash'], clef: ['provider/clef_flash'] },
    { gemma: ['cloudflare_clef', 'clef-flash-extra'] },
    { gemma: ['private-synthetic-token/clef-flash'] },
  ]) {
    const { run, calls } = fixture(models);
    const result = await run();
    assert.equal(result.success, false);
    assert.equal(result.target, null);
    assert.equal(inferences(calls).length, 0);
    assert.ok(!JSON.stringify(result).includes(env.AGENT_SHARED_TOKEN));
  }
});
