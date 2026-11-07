import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSmallClefChecks } from '../scripts/check-clef-small.js';

const env = { GATEWAY_BASE_URL: 'http://gateway.synthetic:9000', AGENT_SHARED_TOKEN: 'private-synthetic-token' };
const requestUuid = '00000000-1111-4222-8333-444444444444';
const result = { results: { cliente_felicito_al_asistente: { status: 'evaluado', value: 1,
  reason: 'Felicitación explícita del cliente.', evidence_message_ids: ['m2'] } } };
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(change = () => {}) {
  const requests = [], events = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body), index = requests.length;
    requests.push({ url, options, body });
    const envelope = { ok: true, tool_key: 'gemma', method: 'POST', path: '/v1/chat/completions',
      request_uuid: requestUuid, upstream_status_code: 200,
      response: { model: 'cloudflare_clef', usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(index === 0 ? { ok: true } : result) } }] } };
    return change({ index, envelope, body }) || response(envelope);
  };
  return { requests, events, run: (options = {}) => runSmallClefChecks({ env, fetchImpl, onStage: stage => events.push(stage), ...options }) };
}

test('three successful probes preserve identical one-variable prompts and parameters except response_format', async () => {
  const { run, requests, events } = fixture();
  const report = await run();
  assert.equal(report.success, true);
  assert.equal(requests.length, 3);
  assert.equal(events.length, 3);
  assert.deepEqual(report.skipped, []);
  assert.ok(report.stages.every(stage => stage.completed && stage.jsonValid && stage.contractValid && stage.expectedResult));
  const plain = requests[1].body.body, structured = structuredClone(requests[2].body.body);
  assert.equal(structured.response_format.type, 'json_schema');
  delete structured.response_format;
  assert.deepEqual(structured, plain);
  assert.equal(report.stages[1].messagesHash, report.stages[2].messagesHash);
  assert.equal(plain.max_tokens, 512);
  for (const request of requests) {
    assert.equal(request.body.timeout_ms, 180000);
    assert.equal(request.body.portal_key, 'portal-pulso');
    assert.equal(request.body.body.model, 'cloudflare_clef');
    assert.ok(request.url.endsWith('/v1/tools/gemma/invoke'));
  }
  assert.ok(!JSON.stringify(report).includes(result.results.cliente_felicito_al_asistente.reason));
});

test('a baseline timeout stops the chain after one request and retains safe transport metadata', async () => {
  const { run, requests } = fixture(({ envelope }) => response({ ...envelope, ok: false, upstream_status_code: 504,
    error: { message: env.GATEWAY_BASE_URL, secret: env.AGENT_SHARED_TOKEN } }, 504));
  const report = await run();
  assert.equal(requests.length, 1);
  assert.equal(report.success, false);
  assert.equal(report.stages[0].errorCode, 'AI_TRANSIENT');
  assert.equal(report.stages[0].protocol.gatewayHttpStatus, 504);
  assert.equal(report.stages[0].protocol.upstreamStatus, 504);
  assert.equal(report.stages[0].protocol.requestUuid, requestUuid);
  assert.deepEqual(report.skipped, ['one-variable-json', 'one-variable-schema']);
  assert.ok(!JSON.stringify(report).includes(env.AGENT_SHARED_TOKEN));
  assert.ok(!JSON.stringify(report).includes('gateway.synthetic'));
});

test('model mismatch and token truncation stop further probes without leaking response content', async () => {
  for (const variant of ['model', 'length']) {
    const { run, requests } = fixture(({ envelope }) => {
      const payload = envelope.response;
      payload.choices[0].message.content = env.AGENT_SHARED_TOKEN;
      payload.choices[0].message.reasoning_content = env.GATEWAY_BASE_URL;
      if (variant === 'model') payload.model = env.GATEWAY_BASE_URL;
      else payload.choices[0].finish_reason = 'length';
      return response(envelope);
    });
    const report = await run();
    assert.equal(requests.length, 1);
    assert.equal(report.success, false);
    assert.equal(report.stages[0].completed, false);
    if (variant === 'model') {
      assert.equal(report.stages[0].identityMatches, false);
      assert.equal(report.stages[0].actualModel, null);
      assert.equal(report.stages[0].protocol.actualModel, null);
    } else assert.equal(report.stages[0].finishReason, 'length');
    assert.ok(!JSON.stringify(report).includes(env.AGENT_SHARED_TOKEN));
    assert.ok(!JSON.stringify(report).includes('gateway.synthetic'));
  }
});

test('schema rejection keeps the successful plain JSON result visible', async () => {
  const { run, requests } = fixture(({ index, envelope }) => index === 2
    ? response({ ...envelope, ok: false, upstream_status_code: 400, error: { message: env.AGENT_SHARED_TOKEN } }) : null);
  const report = await run();
  assert.equal(requests.length, 3);
  assert.equal(report.success, false);
  assert.equal(report.stages[1].completed, true);
  assert.equal(report.stages[1].contractValid, true);
  assert.equal(report.stages[1].expectedResult, true);
  assert.equal(report.stages[2].completed, false);
  assert.equal(report.stages[2].errorCode, 'AI_CONFIGURATION');
  assert.equal(report.stages[2].protocol.upstreamStatus, 400);
  assert.deepEqual(report.skipped, []);
});


test('error diagnostic mode makes only the minimal request even when it succeeds', async () => {
  const { run, requests } = fixture();
  const report = await run({ minimalOnly: true });
  assert.equal(requests.length, 1);
  assert.equal(report.success, true);
  assert.deepEqual(report.skipped, ['one-variable-json', 'one-variable-schema']);
});
