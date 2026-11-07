import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../scripts/check-clef-availability.js';

const env = { GATEWAY_BASE_URL: 'http://gateway.synthetic:9000', AGENT_SHARED_TOKEN: 'private-synthetic-token' };
const requestId = '00000000-1111-4222-8333-444444444444';
const good = () => ({ results: {
  cliente_felicito_al_asistente: { status: 'evaluado', value: 1, reason: 'La felicitación es explícita.', evidence_message_ids: ['synthetic-client-2'] },
  asistente_comunicacion_poco_profesional: { status: 'evaluado', value: 0, reason: 'El asistente mantuvo comunicación profesional.', evidence_message_ids: [] },
} });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function fixture({ models = { qwen: ['clef-flash'], gemma: ['cloudflare_clef'] }, inference, settings } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/tools')) return response({ tools: [...Object.keys(models).map(key => ({ key, status: 'active' })), { key: 'unrelated', status: 'active' }] });
    const body = JSON.parse(options.body);
    const tool = url.match(/\/tools\/([^/]+)\/invoke$/)[1];
    const envelope = { ok: true, tool_key: tool, method: body.method, path: body.path, upstream_status_code: 200, request_uuid: requestId };
    if (body.method === 'GET') return response({ ...envelope, response: { data: models[tool].map(id => ({ id })) } });
    if (inference) return inference({ envelope, body });
    return response({ ...envelope, response: { model: body.body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(good()) } }] } });
  };
  const readConfiguration = settings || (async () => ({ localModelConfiguration: { profiles: [{ id: 'clef-local', toolKey: 'qwen', model: 'clef-flash', enabled: true, responseFormat: 'json_schema' }] }, aiPolicy: { version: 6, mode: 'single', primaryId: 'gemma-local', secondaryId: null, fallbackId: null }, dailyEnabled: false }));
  return { calls, run: (args = []) => main({ args, env, fetchImpl, readConfiguration }) };
}
const inferenceCalls = calls => calls.filter(call => call.options.body && JSON.parse(call.options.body).method === 'POST');

test('Clef check discovers only allowed tools and makes one bounded synthetic inference without altering policy', async () => {
  const { calls, run } = fixture();
  const result = await run();
  assert.equal(result.success, true);
  assert.equal(result.candidate.toolKey, 'qwen');
  assert.equal(result.candidate.matchesConfiguredProfile, true);
  assert.equal(result.policy.primaryId, 'gemma-local');
  assert.equal(result.policy.dailyEnabled, false);
  assert.equal(calls.length, 4);
  assert.equal(inferenceCalls(calls).length, 1);
  const invocation = JSON.parse(inferenceCalls(calls)[0].options.body);
  assert.equal(invocation.timeout_ms, 60000);
  assert.equal(invocation.body.max_tokens, 2048);
  assert.equal(invocation.portal_key, 'portal-pulso');
  assert.equal(invocation.body.response_format.type, 'json_schema');
  assert.match(invocation.body.messages.at(-1).content, /synthetic-client-2/);
  assert.equal(result.probe.valid, 2);
  assert.deepEqual(result.probe.transport, { gatewayStatus: 200, upstreamStatus: 200, request_uuid: requestId, actualModel: 'clef-flash' });
  assert.ok(!JSON.stringify(result).includes('La felicitación es explícita'));
  assert.ok(!JSON.stringify(result).includes(env.AGENT_SHARED_TOKEN));
});

test('unique Clef on gemma remains testable when the database is unavailable', async () => {
  const { run, calls } = fixture({ models: { qwen: ['other-model'], gemma: ['cloudflare_clef'] }, settings: async () => { throw new Error(env.AGENT_SHARED_TOKEN); } });
  const result = await run();
  assert.equal(result.success, true);
  assert.equal(result.configurationRead, 'unavailable');
  assert.equal(result.candidate.toolKey, 'gemma');
  assert.equal(result.candidate.model, 'cloudflare_clef');
  assert.equal(inferenceCalls(calls).length, 1);
});

test('ambiguous Clef identifiers stop before inference', async () => {
  const { run, calls } = fixture({ models: { clef: ['clef-one'], qwen: ['clef-two'], gemma: ['cloudflare_clef'] } });
  const result = await run();
  assert.equal(result.error.code, 'CLEF_MODEL_AMBIGUOUS');
  assert.equal(result.inferenceCount, 0);
  assert.equal(inferenceCalls(calls).length, 0);
  assert.equal(calls.length, 4);
});

test('outer and upstream failures retain safe protocol metadata, without retry or fallback', async () => {
  for (const gatewayStatus of [200, 400]) {
    const { run, calls } = fixture({ inference: ({ envelope }) => response({ ...envelope, ok: false, upstream_status_code: 400,
      response: { model: 'clef-flash', content: env.AGENT_SHARED_TOKEN }, error: { message: env.GATEWAY_BASE_URL, token: env.AGENT_SHARED_TOKEN } }, gatewayStatus) });
    const result = await run();
    assert.equal(result.success, false);
    assert.equal(result.probe.error.code, 'AI_CONFIGURATION');
    assert.deepEqual(result.probe.transport, { gatewayStatus, upstreamStatus: 400, request_uuid: requestId, actualModel: 'clef-flash' });
    assert.equal(inferenceCalls(calls).length, 1);
    assert.ok(!JSON.stringify(result).includes(env.AGENT_SHARED_TOKEN));
    assert.ok(!JSON.stringify(result).includes(env.GATEWAY_BASE_URL));
  }
});

test('identity mismatch is rejected and malicious diagnostic fields are redacted', async () => {
  const { run } = fixture({ inference: ({ envelope }) => response({ ...envelope, request_uuid: env.AGENT_SHARED_TOKEN,
    response: { model: env.GATEWAY_BASE_URL, choices: [] } }) });
  const result = await run();
  assert.equal(result.success, false);
  assert.equal(result.probe.transport.request_uuid, null);
  assert.equal(result.probe.transport.actualModel, null);
  assert.ok(!JSON.stringify(result).includes(env.AGENT_SHARED_TOKEN));
  assert.ok(!JSON.stringify(result).includes('gateway.synthetic'));
});

test('valid JSON with incorrect synthetic semantics is not a successful check', async () => {
  const { run } = fixture({ inference: ({ envelope, body }) => {
    const raw = good();
    raw.results.cliente_felicito_al_asistente = { status: 'no_evaluado', value: null, reason: 'No puedo decidir.', evidence_message_ids: [] };
    return response({ ...envelope, response: { model: body.body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] } });
  } });
  const result = await run();
  assert.equal(result.probe.valid, 2);
  assert.equal(result.probe.semanticChecks.explicitCongratulations, false);
  assert.equal(result.success, false);
});

test('help and invalid arguments perform no discovery, configuration reads or inference', async () => {
  const forbidden = async () => assert.fail('Unexpected external operation');
  assert.equal((await main({ args: ['--help'], env: {}, fetchImpl: forbidden, readConfiguration: forbidden })).help, true);
  await assert.rejects(main({ args: ['--execute'], env: {}, fetchImpl: forbidden, readConfiguration: forbidden }), error => error.code === 'INVALID_ARGUMENTS');
});


test('explicit mounted probe selects cloudflare_clef on gemma while preserving the legacy configuration', async () => {
  const { run, calls } = fixture();
  const result = await run(['--mounted-clef']);
  assert.equal(result.success, true);
  assert.equal(result.candidate.toolKey, 'gemma');
  assert.equal(result.candidate.model, 'cloudflare_clef');
  assert.equal(result.candidate.matchesConfiguredProfile, false);
  assert.equal(result.configuredClef.model, 'clef-flash');
  assert.equal(result.policy.mode, 'single');
  assert.equal(inferenceCalls(calls).length, 1);
});

test('explicit mounted probe never falls back to a different Clef if the target is missing', async () => {
  const { run, calls } = fixture({ models: { qwen: ['clef-flash'], gemma: ['gemma-4'] } });
  const result = await run(['--mounted-clef']);
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'CLEF_MODEL_NOT_FOUND');
  assert.equal(inferenceCalls(calls).length, 0);
});
