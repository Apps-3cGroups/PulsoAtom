import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { diagnose, parseDiagnosticArgs } from '../scripts/diagnose-clef.mjs';

const env = { GATEWAY_BASE_URL: 'https://gateway.example.invalid', AGENT_SHARED_TOKEN: 'SYNTHETIC-SECRET', GATEWAY_PORTAL_KEY: 'portal-pulso' };
const envelope = response => ({ ok: true, tool_key: 'qwen', method: 'POST', path: '/v1/chat/completions',
  request_uuid: 'synthetic-request', upstream_status_code: 200, response });
const output = (content = '{"ok":true}') => ({ model: 'clef-flash', choices: [{ finish_reason: 'stop', message: { content } }] });
const assertRedacted = result => assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-SECRET|example\.invalid|private-provider|PRIVATE_TRANSCRIPT/);

test('each mode sends one synthetic request; body changes only response_format and never exposes credentials', async () => {
  const requests = [];
  for (const mode of ['basic', 'schema', 'json']) {
    let count = 0;
    const result = await diagnose({ mode, env, fetchImpl: async (url, options) => {
      count++;
      assert.equal(url, 'https://gateway.example.invalid/v1/tools/qwen/invoke');
      assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers['X-Gateway-Token'], env.AGENT_SHARED_TOKEN);
      assert.ok(options.signal instanceof AbortSignal);
      const data = JSON.parse(options.body); requests.push(data.body);
      assert.equal(data.body.max_tokens, 128); assert.equal(data.body.model, 'clef-flash');
      assert.equal(data.timeout_ms, 60000); assert.equal(data.portal_key, 'portal-pulso');
      assert.equal(data.path, '/v1/chat/completions'); assert.equal(data.method, 'POST');
      assert.equal(data.caller.operation, `diagnostico-clef-${mode}`);
      assert.equal(data.body.messages.length, 1); assert.match(data.body.messages[0].content, /sin datos reales/);
      assert.equal(data.body.stream, false);
      return Response.json(envelope(output()));
    } });
    assert.equal(count, 1); assert.equal(result.success, true); assert.equal(result.transportAccepted, true);
    assert.equal(result.requestUuid, 'synthetic-request'); assertRedacted(result);
    assert.doesNotMatch(JSON.stringify(result), /"(?:messages|headers|content|choices)":/);
  }
  const [basic, schema, json] = requests;
  assert.equal(basic.response_format, undefined);
  assert.equal(schema.response_format.type, 'json_schema'); assert.equal(schema.response_format.json_schema.strict, true);
  assert.deepEqual(json.response_format, { type: 'json_object' });
  const { response_format: schemaFormat, ...schemaBody } = schema;
  const { response_format: jsonFormat, ...jsonBody } = json;
  assert.deepEqual(basic, schemaBody); assert.deepEqual(basic, jsonBody);
});

test('outer HTTP400 and upstream400 remain distinct while error text is never returned', async () => {
  const rawError = `Path not allowed. ${env.AGENT_SHARED_TOKEN} ${env.GATEWAY_BASE_URL} PRIVATE_TRANSCRIPT`;
  const outer = await diagnose({ env, fetchImpl: async () => Response.json({ detail: rawError }, { status: 400 }) });
  const inner = await diagnose({ env, fetchImpl: async () => Response.json({ ...envelope({ error: { message: rawError } }),
    ok: false, upstream_status_code: 400 }) });
  assert.equal(outer.gatewayHttpStatus, 400); assert.equal(outer.upstreamStatusCode, null); assert.equal(outer.failureLayer, 'gateway_http');
  assert.equal(inner.gatewayHttpStatus, 200); assert.equal(inner.upstreamStatusCode, 400); assert.equal(inner.requestUuid, 'synthetic-request');
  for (const result of [outer, inner]) {
    assert.equal(result.success, false); assert.equal(result.transportAccepted, false);
    assert.match(result.diagnosticHint, /ruta permitida/); assert.equal(result.hintIsHeuristic, true); assertRedacted(result);
  }
});

test('JSON mode rejection returns only allowlisted error code, type and parameter, with no automatic retry', async () => {
  let count = 0;
  const result = await diagnose({ mode: 'json', env, fetchImpl: async (_, options) => {
    count++; assert.equal(JSON.parse(options.body).body.response_format.type, 'json_object');
    return Response.json({ ...envelope({ error: { code: 'unsupported_parameter', type: 'invalid_request_error',
      param: 'response_format', message: `${env.AGENT_SHARED_TOKEN} ${env.GATEWAY_BASE_URL} PRIVATE_TRANSCRIPT` } }),
    ok: false, upstream_status_code: 400, error: { code: 'invalid_request', param: 'body', message: 'PRIVATE_TRANSCRIPT' } });
  } });
  assert.equal(count, 1); assert.equal(result.success, false);
  assert.deepEqual(result.gatewayError, { code: 'invalid_request', param: 'body' });
  assert.deepEqual(result.upstreamError, { code: 'unsupported_parameter', type: 'invalid_request_error', param: 'response_format' });
  assert.match(result.diagnosticHint, /formato JSON/); assertRedacted(result);
});

test('malicious envelope fields, error metadata and malformed gatewayOk never leak or claim success', async () => {
  for (const malicious of [env.AGENT_SHARED_TOKEN, env.GATEWAY_BASE_URL, 'http://private-provider:1234', 'PRIVATE_TRANSCRIPT']) {
    const result = await diagnose({ env, fetchImpl: async () => Response.json({ ...envelope(output()), ok: malicious,
      request_uuid: env.AGENT_SHARED_TOKEN, response: { ...output(), model: env.GATEWAY_BASE_URL,
        error: { code: malicious, type: malicious, param: malicious, message: malicious } },
      error: { code: malicious, type: malicious, param: malicious, message: malicious } }) });
    assert.equal(result.gatewayOk, null); assert.equal(result.success, false); assert.equal(result.transportAccepted, false);
    assert.equal(result.gatewayError, null); assert.equal(result.upstreamError, null);
    assert.equal(result.requestUuid, null); assert.equal(result.actualModel, null); assertRedacted(result);
  }
});

test('accepted transport is separate from valid model identity, JSON, finish reason and Gateway envelope', async () => {
  for (const change of [
    value => { value.response.model = 'another-model'; },
    value => { value.response.choices[0].message.content = '```json\n{"ok":true}\n```'; },
    value => { value.response.choices[0].message.content = '{"ok":true,"extra":1}'; },
    value => { value.response.choices[0].finish_reason = 'length'; },
    value => { value.response.choices[0].message.refusal = 'PRIVATE_TRANSCRIPT'; },
    value => { delete value.request_uuid; },
  ]) {
    const value = envelope(output()); change(value);
    const result = await diagnose({ mode: 'schema', env, fetchImpl: async () => Response.json(value) });
    assert.equal(result.success, false); assert.equal(result.transportAccepted, true);
    assert.equal(result.failureLayer, 'response_contract'); assertRedacted(result);
  }
  for (const change of [{ ok: false }, { tool_key: 'other' }, { path: '/another/path' }, { upstream_status_code: '200' }, { upstream_status_code: 999 }]) {
    const result = await diagnose({ env, fetchImpl: async () => Response.json({ ...envelope(output()), ...change }) });
    assert.equal(result.success, false); assert.equal(result.transportAccepted, false);
  }
});

test('malformed JSON and transport failures remain sanitized without retries', async () => {
  let count = 0;
  const malformed = await diagnose({ env, fetchImpl: async () => { count++; return new Response(`PRIVATE_TRANSCRIPT ${env.AGENT_SHARED_TOKEN}`); } });
  assert.equal(malformed.success, false); assert.equal(malformed.gatewayHttpStatus, 200); assert.equal(malformed.upstreamStatusCode, null);
  assertRedacted(malformed);
  const transport = await diagnose({ env, fetchImpl: async () => { count++; throw new Error(`${env.AGENT_SHARED_TOKEN} PRIVATE_TRANSCRIPT`); } });
  assert.equal(count, 2); assert.equal(transport.success, false); assert.equal(transport.failureLayer, 'transport'); assertRedacted(transport);
});

test('invalid arguments and unsafe configuration are rejected before any service call; blank portal identity is not defaulted', async () => {
  assert.equal(parseDiagnosticArgs([]), 'basic'); assert.equal(parseDiagnosticArgs(['schema']), 'schema');
  for (const args of [['--probe'], ['basic', 'schema'], ['--url', env.GATEWAY_BASE_URL]]) assert.throws(() => parseDiagnosticArgs(args), /un modo/);
  const fetchImpl = () => assert.fail('Configuration errors must never contact the Gateway');
  for (const config of [{}, { ...env, GATEWAY_BASE_URL: 'file:///private/config' },
    { ...env, GATEWAY_BASE_URL: 'https://user:password@gateway.example.invalid' }, { ...env, GATEWAY_BASE_URL: `${env.GATEWAY_BASE_URL}?token=secret` },
    { ...env, AGENT_SHARED_TOKEN: '' }, { ...env, AGENT_SHARED_TOKEN: 'invalid\nheader' },
    { ...env, GATEWAY_PORTAL_KEY: '' }, { ...env, GATEWAY_PORTAL_KEY: 'other-portal' }]) {
    await assert.rejects(diagnose({ env: config, fetchImpl }));
  }
  const noPortal = { ...env }; delete noPortal.GATEWAY_PORTAL_KEY;
  const result = await diagnose({ env: noPortal, fetchImpl: async () => Response.json(envelope(output())) });
  assert.equal(result.portalKey, 'portal-pulso');
});

test('CLI rejects unexpected parameters without printing their contents', () => {
  const script = new URL('../scripts/diagnose-clef.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, 'basic', env.AGENT_SHARED_TOKEN], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /un modo/); assert.doesNotMatch(result.stderr, /SYNTHETIC-SECRET/);
  assert.equal(result.stdout, '');
});
