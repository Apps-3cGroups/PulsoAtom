import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayApiClient } from '../src/services/gatewayApiClient.js';
import { GatewayEvaluator } from '../src/gateway-evaluator.js';
import { evaluationInput, evaluationInstructions, evaluationSchema } from '../src/evaluator.js';
import { CLEF_FLASH_OUTPUT_SCHEMA_VERSION, clefFlashEvaluationSchema } from '../src/services/clefFlashSchema.js';
import { CLEF_FLASH_DECISION_INSTRUCTIONS_VERSION, clefFlashDecisionInstructions } from '../src/services/clefFlashInstructions.js';

const base = { baseUrl: 'http://gateway.test:9000', token: 'synthetic-secret-token', portalKey: 'pulsoAtom', toolKey: 'gemma', model: 'synthetic-gemma', timeoutMs: 180000 };
const requestId = '00000000-1111-4222-8333-444444444444';
const conversation = { id: 'synthetic-chat', completed: true, messages: [
  { id: 'm1', actor: 'cliente', text: '¿Tienen este producto?', timestamp: '2026-11-06T12:00:00Z' },
  { id: 'm2', actor: 'humano', text: 'Sí, está disponible.', timestamp: '2026-11-06T12:01:00Z' },
] };
const variables = [
  { id: 'event', name: 'Evento sintético', type: 'Flag', method: 'IA', definition: 'Evento visible.', mark: 'Normal', condition: '' },
  { id: 'tipo_interaccion', name: 'Tipo', type: 'Descriptor', method: 'IA', definition: 'Clasifica la interacción.', mark: '', condition: '' },
];
const valid = () => ({ results: {
  event: { status: 'evaluado', value: 1, reason: 'Hay disponibilidad explícita.', evidence_message_ids: ['m2'] },
  tipo_interaccion: { status: 'evaluado', value: 'disponibilidad', reason: 'El cliente consulta disponibilidad.', evidence_message_ids: ['m1'] },
} });
const payload = (raw = valid()) => ({ id: 'upstream-synthetic-id', model: base.model,
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(raw) } }],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
const envelope = (response = payload()) => ({ ok: true, tool_key: 'gemma', request_uuid: requestId,
  method: 'POST', path: '/v1/chat/completions', upstream_status_code: 200, latency_ms: 123, response });
const mockResponse = (json, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return json; } });
const evaluator = (json = envelope(), overrides = {}) => {
  const calls = [];
  const instance = new GatewayEvaluator({ ...base, fetchImpl: async (...args) => { calls.push(args); return mockResponse(json); }, ...overrides });
  return { instance, calls };
};
const code = expected => error => { assert.equal(error.code, expected); return true; };

test('Gateway sends the audited envelope only to the configured backend and validates the common contract', async () => {
  const { instance, calls } = evaluator();
  assert.equal(instance.configured, true);
  const answer = await instance.evaluate(conversation, variables);
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, base.baseUrl + '/v1/tools/gemma/invoke');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers['X-Gateway-Token'], base.token);
  assert.equal(options.headers.Accept, 'application/json');
  const body = JSON.parse(options.body);
  assert.deepEqual(body, { method: 'POST', path: '/v1/chat/completions', query: {}, timeout_ms: 180000,
    portal_key: base.portalKey, caller: { source: base.portalKey, mode: 'portal', operation: 'evaluacion-calidad' },
    body: { model: base.model, messages: [{ role: 'system', content: evaluationInstructions }, { role: 'user', content: evaluationInput(conversation, variables) }],
      temperature: 0, max_tokens: 16000, stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'pulso_evaluation', strict: true, schema: evaluationSchema(variables) } } } });
  assert.equal(answer.model, base.model);
  assert.equal(instance.outputSchemaVersion, undefined);
  assert.equal(answer.outputSchemaVersion, undefined);
  assert.equal(instance.decisionInstructionsVersion, undefined);
  assert.equal(answer.decisionInstructionsVersion, undefined);
  assert.equal(answer.responseId, requestId);
  assert.deepEqual(answer.usage, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  assert.deepEqual(answer.validationErrors, []);
  assert.deepEqual(answer.results[0].evidence, [{ messageId: 'm2', quote: conversation.messages[1].text }]);
  assert.ok(!JSON.stringify(answer).includes(base.token));
  assert.ok(!JSON.stringify(instance).includes(base.token));
});

test('JSON object mode is explicit, supplies the same schema and never silently changes mode', async () => {
  const { instance, calls } = evaluator(envelope(), { responseFormat: 'json_object', maxTokens: 8192, temperature: 0.2 });
  await instance.evaluate(conversation, variables);
  const body = JSON.parse(calls[0][1].body).body;
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].content, evaluationInstructions);
  assert.ok(body.messages[1].content.endsWith(JSON.stringify(evaluationSchema(variables))));
  assert.equal(body.messages[2].content, evaluationInput(conversation, variables));
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.temperature, 0.2);
});

test('partial replies retain valid answers and identify only missing or invalid variables for retry', async () => {
  const raw = valid();
  raw.results.tipo_interaccion.evidence_message_ids = ['invented'];
  const answer = await evaluator(envelope(payload(raw))).instance.evaluate(conversation, variables);
  assert.deepEqual(answer.results.map(r => r.variableId), ['event']);
  assert.deepEqual(answer.validationErrors.map(r => [r.variableId, r.rules]), [['tipo_interaccion', ['unknown_evidence_message']]]);
  delete raw.results.tipo_interaccion;
  const missing = await evaluator(envelope(payload(raw))).instance.evaluate(conversation, variables);
  assert.deepEqual(missing.results.map(r => r.variableId), ['event']);
  assert.deepEqual(missing.validationErrors[0].rules, ['missing_item']);
});

test('Clef captured status/value contradictions remain pending instead of becoming absent events', async () => {
  const raw = valid();
  raw.results.event = { status: 'no_evaluado', value: 0, reason: 'Respuesta sintética contradictoria.', evidence_message_ids: [] };
  const response = payload(); response.model = 'clef-flash';
  response.choices[0].message = { content: '', reasoning_content: JSON.stringify(raw) };
  const answer = await evaluator(envelope(response), { model: 'clef-flash' }).instance.evaluate(conversation, variables);
  assert.equal(answer.responseField, 'reasoning_content');
  assert.deepEqual(answer.results.map(r => r.variableId), ['tipo_interaccion']);
  assert.deepEqual(answer.validationErrors.map(e => [e.variableId, e.rules]), [['event', ['inconsistent_status_value']]]);
});

test('abstention is a valid result and is never converted to no flag', async () => {
  const raw = { results: { event: { status: 'no_evaluado', value: null, reason: 'Contexto insuficiente.', evidence_message_ids: [] } } };
  const answer = await evaluator(envelope(payload(raw))).instance.evaluate(conversation, [variables[0]]);
  assert.deepEqual(answer.validationErrors, []);
  assert.equal(answer.results[0].status, 'no_evaluado');
  assert.equal(answer.results[0].value, null);
});

test('responses must prove the exact configured model identity', async () => {
  for (const [model, expected] of [[undefined, 'MODEL_IDENTITY_UNVERIFIED'], ['', 'MODEL_IDENTITY_UNVERIFIED'], ['another-model', 'MODEL_CHANGED']]) {
    const response = payload(); response.model = model;
    await assert.rejects(evaluator(envelope(response)).instance.evaluate(conversation, variables), code(expected));
  }
});

test('numbered runtime instances require native inventory and preserve both identities', async () => {
  const response = payload(); response.model = `${base.model}:2`;
  const paths = [];
  const instance = new GatewayEvaluator({ ...base, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); paths.push(request.path);
    return mockResponse(request.path === '/v1/chat/completions' ? envelope(response) : {
      ...envelope({ models: [{ key: base.model, type: 'llm', loaded_instances: [{ id: response.model, config: { context_length: 8192 } }] }] }),
      method: 'GET', path: '/api/v1/models',
    });
  } });
  const answer = await instance.evaluate(conversation, variables);
  assert.deepEqual(paths, ['/v1/chat/completions', '/api/v1/models']);
  assert.equal(answer.model, base.model);
  assert.deepEqual(answer.runtimeIdentity, { modelKey: base.model, instanceId: response.model,
    inventoryRequestId: requestId, responseRequestId: requestId, contextLength: 8192 });
  assert.deepEqual(answer.validationErrors, []);
});

test('context rejection divides only the checklist and preserves the full conversation', async () => {
  const requests = [];
  const instance = new GatewayEvaluator({ ...base, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body).body; requests.push(request);
    const ids = Object.keys(request.response_format.json_schema.schema.properties.results.properties);
    if (ids.length > 1) return mockResponse({ ...envelope(), ok: false, upstream_status_code: 400,
      response: { error: { code: 'context_length_exceeded', message: 'Context length exceeded' } } });
    const raw = valid(); raw.results = Object.fromEntries(ids.map(id => [id, raw.results[id]]));
    return mockResponse(envelope(payload(raw)));
  } });
  const answer = await instance.evaluate(conversation, variables);
  assert.equal(answer.results.length, 2);
  assert.deepEqual(answer.validationErrors, []);
  assert.equal(answer.contextBatches.length, 2);
  for (const request of requests) {
    assert.equal(request.messages[0].content, evaluationInstructions);
    for (const message of conversation.messages) assert.ok(request.messages.at(-1).content.includes(message.text));
  }
});

test('context still too small for one variable remains an explicit error', async () => {
  const instance = evaluator({ ...envelope(), ok: false, upstream_status_code: 400,
    response: { error: { code: 'context_length_exceeded', message: 'Context length exceeded' } } }).instance;
  await assert.rejects(instance.evaluate(conversation, [variables[0]]), code('AI_CONTEXT_LIMIT'));
});

test('a later context batch failure retains validated earlier answers', async () => {
  let singles = 0;
  const instance = new GatewayEvaluator({ ...base, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body).body;
    const ids = Object.keys(request.response_format.json_schema.schema.properties.results.properties);
    if (ids.length > 1) return mockResponse({ ...envelope(), ok: false, upstream_status_code: 400,
      response: { error: { code: 'context_length_exceeded' } } });
    if (++singles === 2) return mockResponse({}, 503);
    const raw = valid(); raw.results = Object.fromEntries(ids.map(id => [id, raw.results[id]]));
    return mockResponse(envelope(payload(raw)));
  } });
  const answer = await instance.evaluate(conversation, variables);
  assert.deepEqual(answer.results.map(r => r.variableId), ['event']);
  assert.equal(answer.failure.code, 'AI_TRANSIENT');
  assert.equal(answer.contextBatches.length, 1);
});

test('refusals and content filtering require intervention, while truncated answers remain incomplete', async () => {
  for (const change of [{ refusal: 'Rejected' }, { finish_reason: 'content_filter' }, { finish_reason: 'length' }]) {
    const response = payload();
    if (change.refusal) response.choices[0].message.refusal = change.refusal;
    else response.choices[0].finish_reason = change.finish_reason;
    await assert.rejects(evaluator(envelope(response)).instance.evaluate(conversation, variables), code(change.finish_reason === 'length' ? 'AI_INCOMPLETE' : 'AI_SAFETY_REFUSAL'));
  }
});

test('invalid JSON, Markdown wrappers, unknown variables and malformed choices cannot become results', async () => {
  for (const malformed of ['```json\n' + JSON.stringify(valid()) + '\n```', 'not JSON', JSON.stringify({ results: { unknown: valid().results.event } })]) {
    const response = payload(); response.choices[0].message.content = malformed;
    await assert.rejects(evaluator(envelope(response)).instance.evaluate(conversation, variables), code('INVALID_AI_RESULT'));
  }
  for (const choices of [null, [], [payload().choices[0], payload().choices[0]]]) {
    const response = payload(); response.choices = choices;
    await assert.rejects(evaluator(envelope(response)).instance.evaluate(conversation, variables), code('INVALID_AI_RESULT'));
  }
});

test('HTTP configuration and transient errors are classified without reading or exposing provider errors', async () => {
  for (const status of [400, 401, 403, 404, 408, 429, 502, 503, 504]) {
    let bodyRead = false;
    const { instance, calls } = evaluator(null, { fetchImpl: async () => ({ status, ok: false,
      async json() { bodyRead = true; return { token: base.token, url: base.baseUrl }; } }) });
    await assert.rejects(instance.evaluate(conversation, variables), error => {
      assert.equal(error.code, [408, 429].includes(status) || status >= 500 ? 'AI_TRANSIENT' : 'AI_CONFIGURATION');
      assert.ok(!error.message.includes(base.token)); assert.ok(!error.message.includes(base.baseUrl));
      return true;
    });
    assert.equal(bodyRead, false);
    assert.equal(calls.length, 0);
  }
});

test('a successful Gateway HTTP response still requires a successful, matching upstream envelope', async () => {
  for (const changed of [{ ok: false }, { tool_key: 'other' }, { method: 'GET' }, { path: '/other' },
    { upstream_status_code: '200' }, { upstream_status_code: 0 }, { request_uuid: 'http://private/token' }, { request_uuid: null }]) {
    await assert.rejects(evaluator({ ...envelope(), ...changed }).instance.evaluate(conversation, variables), code('INVALID_AI_RESULT'));
  }
  for (const status of [400, 401, 502, 503, 504]) {
    await assert.rejects(evaluator({ ...envelope(), ok: false, upstream_status_code: status }).instance.evaluate(conversation, variables), code(status >= 500 ? 'AI_TRANSIENT' : 'AI_CONFIGURATION'));
  }
});

test('network/timeout errors and malformed Gateway JSON are sanitized', async () => {
  for (const name of ['TimeoutError', 'TypeError']) {
    const { instance } = evaluator(null, { fetchImpl: async () => { throw Object.assign(new Error(`${base.baseUrl} ${base.token}`), { name }); } });
    await assert.rejects(instance.evaluate(conversation, variables), error => {
      assert.equal(error.code, 'AI_UNAVAILABLE');
      assert.ok(!JSON.stringify(error).includes(base.token)); assert.ok(!error.message.includes(base.baseUrl));
      return true;
    });
  }
  const { instance } = evaluator(null, { fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new Error(base.token); } }) });
  await assert.rejects(instance.evaluate(conversation, variables), code('INVALID_AI_RESULT'));
});

test('only safe numeric usage fields leave the adapter', async () => {
  const response = payload(); response.usage = { prompt_tokens: -1, completion_tokens: 20.5, total_tokens: 50, secret: base.token, upstream: base.baseUrl };
  const answer = await evaluator(envelope(response)).instance.evaluate(conversation, variables);
  assert.deepEqual(answer.usage, { total_tokens: 50 });
});

test('unconfigured or unsupported requests never call the Gateway', async () => {
  for (const change of [{ baseUrl: '' }, { baseUrl: 'ftp://gateway.test' }, { baseUrl: 'http://user:pass@gateway.test' },
    { baseUrl: 'http://gateway.test?secret=1' }, { token: '' }, { token: 'token\nX-Injected: yes' }, { portalKey: '' },
    { toolKey: '../gemma' }, { model: '' }, { timeoutMs: 999 }, { timeoutMs: 180001 }, { maxTokens: 0 }, { responseFormat: 'off' }]) {
    const { instance, calls } = evaluator(envelope(), change);
    assert.equal(instance.configured, false);
    await assert.rejects(instance.evaluate(conversation, variables), code('AI_CONFIGURATION'));
    assert.equal(calls.length, 0);
  }
  const { instance, calls } = evaluator();
  await assert.rejects(instance.evaluate(conversation, [{ ...variables[0], method: 'Código' }]), code('UNSUPPORTED_VARIABLE'));
  await assert.rejects(instance.evaluate({ ...conversation, messages: [] }, variables), code('EMPTY_CONVERSATION'));
  assert.equal(calls.length, 0);
});

test('catalog and model discovery remain at the Gateway, with no direct provider connection', async () => {
  const calls = [];
  const catalog = [{ key: 'gemma', base_url: 'http://internal-provider.test:1234', status: 'active' }];
  const client = new GatewayApiClient({ ...base, fetchImpl: async (url, options) => {
    calls.push([url, options]);
    return mockResponse(url.endsWith('/v1/tools') ? catalog : { ...envelope({ data: [{ id: base.model }] }), method: 'GET', path: '/v1/models' });
  } });
  assert.deepEqual(await client.listTools(), catalog);
  const answer = await client.invoke({ toolKey: 'gemma', method: 'GET', path: '/v1/models', operation: 'preflight' });
  assert.deepEqual(answer.response, { data: [{ id: base.model }] });
  assert.equal(answer.requestId, requestId);
  assert.equal(answer.latencyMs, 123);
  assert.ok(calls.every(([url]) => url.startsWith(base.baseUrl + '/v1/tools')));
  const models = JSON.parse(calls[1][1].body);
  assert.equal(models.body, null);
  assert.equal(models.caller.operation, 'preflight');
  for (const operation of [{ method: 'POST', path: '/api/v1/chat' }, { method: 'GET', path: '/v1/chat/completions' }, { method: 'GET', path: 'http://internal-provider.test:1234/v1/models' }]) {
    await assert.rejects(client.invoke({ toolKey: 'gemma', ...operation }), code('AI_CONFIGURATION'));
  }
  assert.equal(calls.length, 2);
});

test('evaluator discovery reuses its private Gateway configuration without exposing the shared token', async () => {
  const catalog = [{ key: 'gemma', status: 'active' }];
  const requests = [];
  const instance = new GatewayEvaluator({ ...base, fetchImpl: async (url, options) => {
    requests.push([url, options]);
    return mockResponse(url.endsWith('/v1/tools') ? catalog : { ...envelope({ data: [{ id: base.model }] }), method: 'GET', path: '/v1/models' });
  } });
  const result = await instance.discovery();
  assert.deepEqual(result, { catalog, models: { data: [{ id: base.model }] }, requestId });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(([, options]) => options.headers['X-Gateway-Token'] === base.token));
  assert.ok(!JSON.stringify(result).includes(base.token));
});

const flashPayload = (raw = valid(), content = '') => {
  const response = payload();
  response.model = 'clef-flash';
  response.choices[0].message = { role: 'assistant', content, reasoning_content: JSON.stringify(raw) };
  return response;
};
const flashEvaluator = response => evaluator(envelope(response), { model: 'clef-flash' });

test('Clef clarification preserves detections, negative decisions and abstentions in both response modes', async () => {
  const flags = ['detected', 'absent', 'unknown'].map(id => ({ ...variables[0], id }));
  const raw = { results: {
    detected: { status: 'evaluado', value: 1, reason: 'Evento explícito sintético.', evidence_message_ids: ['m1'] },
    absent: { status: 'evaluado', value: 0, reason: 'El texto relevante permite descartar el evento.', evidence_message_ids: [] },
    // Even this ambiguous reason must never become an absent event by code.
    unknown: { status: 'no_evaluado', value: null, reason: 'No hay evidencia de enojo.', evidence_message_ids: [] },
  } };
  const options = { validationErrors: [{ variableId: 'absent', rules: ['inconsistent_status_value'] }] };
  for (const responseFormat of ['json_schema', 'json_object']) {
    const { instance, calls } = evaluator(envelope(flashPayload(raw)), { model: 'clef-flash', responseFormat });
    const answer = await instance.evaluate(conversation, flags, options);
    const body = JSON.parse(calls[0][1].body).body;
    assert.equal(calls.length, 1);
    assert.equal(body.messages[0].content, `${evaluationInstructions}\n\n${clefFlashDecisionInstructions}`);
    assert.equal(body.messages.at(-1).content, evaluationInput(conversation, flags, options));
    assert.deepEqual(answer.results.map(result => [result.variableId, result.status, result.value]),
      [['detected', 'evaluado', 1], ['absent', 'evaluado', 0], ['unknown', 'no_evaluado', null]]);
    assert.equal(answer.results[2].reason, raw.results.unknown.reason);
    assert.deepEqual(answer.results[0].evidence.map(e => e.messageId), ['m1']);
    assert.deepEqual(answer.validationErrors, []);
    assert.equal(answer.decisionInstructionsVersion, CLEF_FLASH_DECISION_INSTRUCTIONS_VERSION);
  }
});

test('Clef Flash accepts a complete structured answer in reasoning_content only when final content is empty', async () => {
  for (const empty of ['', ' \n ', null, undefined]) {
    const response = flashPayload(valid(), empty);
    if (empty === undefined) delete response.choices[0].message.content;
    const { instance, calls } = flashEvaluator(response);
    const answer = await instance.evaluate(conversation, variables);
    assert.equal(calls.length, 1);
    assert.equal(instance.outputSchemaVersion, CLEF_FLASH_OUTPUT_SCHEMA_VERSION);
    assert.equal(answer.outputSchemaVersion, CLEF_FLASH_OUTPUT_SCHEMA_VERSION);
    assert.equal(answer.decisionInstructionsVersion, CLEF_FLASH_DECISION_INSTRUCTIONS_VERSION);
    const request = JSON.parse(calls[0][1].body).body;
    assert.deepEqual(request.response_format.json_schema.schema, clefFlashEvaluationSchema(variables, conversation));
    assert.deepEqual(request.messages, [{ role: 'system', content: `${evaluationInstructions}\n\n${clefFlashDecisionInstructions}` },
      { role: 'user', content: evaluationInput(conversation, variables) }]);
    assert.equal(answer.responseField, 'reasoning_content');
    assert.equal(answer.model, 'clef-flash');
    assert.equal(answer.responseId, requestId);
    assert.deepEqual(answer.validationErrors, []);
    assert.equal(answer.results.length, 2);
    assert.deepEqual(answer.results[0].evidence, [{ messageId: 'm2', quote: conversation.messages[1].text }]);
    assert.equal(answer.results[1].value, 'disponibilidad');
    assert.ok(!Object.hasOwn(answer, 'reasoning_content'));
    assert.ok(!Object.hasOwn(answer, 'raw'));
  }
});

test('Clef alternate-channel answers preserve partial validation and abstentions without inventing results', async () => {
  const raw = valid();
  raw.results.event = { status: 'no_evaluado', value: null, reason: 'Contexto insuficiente.', evidence_message_ids: [] };
  raw.results.tipo_interaccion.evidence_message_ids = ['invented'];
  const answer = await flashEvaluator(flashPayload(raw)).instance.evaluate(conversation, variables);
  assert.equal(answer.responseField, 'reasoning_content');
  assert.deepEqual(answer.results.map(r => [r.variableId, r.status, r.value]), [['event', 'no_evaluado', null]]);
  assert.deepEqual(answer.validationErrors.map(r => [r.variableId, r.rules]), [['tipo_interaccion', ['unknown_evidence_message']]]);
  delete raw.results.tipo_interaccion;
  const missing = await flashEvaluator(flashPayload(raw)).instance.evaluate(conversation, variables);
  assert.deepEqual(missing.validationErrors[0].rules, ['missing_item']);
  raw.results.event = { status: 'evaluado', value: 1, reason: '', evidence_message_ids: [] };
  const invalid = await flashEvaluator(flashPayload(raw)).instance.evaluate(conversation, variables);
  assert.equal(invalid.results.length, 0);
  assert.deepEqual(invalid.validationErrors[0].rules, ['invalid_reason', 'missing_evidence']);
});

test('a final content answer takes precedence and an invalid nonempty answer is never replaced', async () => {
  const raw = valid(); raw.results.event.value = 0; raw.results.event.evidence_message_ids = [];
  const response = flashPayload(valid(), JSON.stringify(raw));
  response.choices[0].message.reasoning_content = 'PRIVATE_REASONING_MUST_NOT_ESCAPE';
  const answer = await flashEvaluator(response).instance.evaluate(conversation, variables);
  assert.equal(answer.responseField, 'content');
  assert.equal(answer.results[0].value, 0);
  assert.ok(!JSON.stringify(answer).includes('PRIVATE_REASONING_MUST_NOT_ESCAPE'));
  for (const content of ['not JSON', '```json\n{}\n```', '{}', [], {}, 0, false]) {
    await assert.rejects(flashEvaluator(flashPayload(valid(), content)).instance.evaluate(conversation, variables), code('INVALID_AI_RESULT'));
  }
});

test('alternate-channel compatibility is limited to the exact verified Clef Flash identity', async () => {
  const response = flashPayload(); response.model = base.model;
  await assert.rejects(evaluator(envelope(response)).instance.evaluate(conversation, variables), code('INVALID_AI_RESULT'));
  for (const [model, error] of [['cloudflare_clef', 'MODEL_CHANGED'], [undefined, 'MODEL_IDENTITY_UNVERIFIED']]) {
    const mismatch = flashPayload(); mismatch.model = model;
    await assert.rejects(flashEvaluator(mismatch).instance.evaluate(conversation, variables), code(error));
  }
});

test('reasoning prose, JSON fragments, unrelated objects and unexpected checklist variables remain invalid', async () => {
  const secret = 'PRIVATE_REASONING_MUST_NOT_ESCAPE';
  for (const text of [secret, `${secret}\n${JSON.stringify(valid())}`, '```json\n' + JSON.stringify(valid()) + '\n```',
    JSON.stringify({ ...valid(), reasoning: secret }), JSON.stringify({ reasoning: secret }),
    JSON.stringify({ results: { other_variable: valid().results.event } }), '{"results":[]}', 'null', '[]']) {
    const response = flashPayload(); response.choices[0].message.reasoning_content = text;
    await assert.rejects(flashEvaluator(response).instance.evaluate(conversation, variables), error => {
      assert.equal(error.code, 'INVALID_AI_RESULT');
      assert.ok(!error.message.includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
      return true;
    });
  }
});

test('unexpected alternate-channel item fields reject only that variable and feed a scoped retry', async () => {
  const raw = valid(), secret = 'PRIVATE_REASONING_MUST_NOT_ESCAPE';
  raw.results.tipo_interaccion.analysis = secret;
  const first = await flashEvaluator(flashPayload(raw)).instance.evaluate(conversation, variables);
  assert.deepEqual(first.results.map(result => result.variableId), ['event']);
  assert.deepEqual(first.validationErrors, [{ variableId: 'tipo_interaccion', code: 'INVALID_AI_RESULT',
    rules: ['unexpected_fields'], message: 'Respuesta inválida para tipo_interaccion: unexpected_fields.' }]);
  assert.ok(!JSON.stringify(first).includes(secret));

  const pending = variables.filter(variable => first.validationErrors.some(error => error.variableId === variable.id));
  const retry = flashEvaluator(flashPayload({ results: { tipo_interaccion: valid().results.tipo_interaccion } }));
  const corrected = await retry.instance.evaluate(conversation, pending, { validationErrors: first.validationErrors });
  assert.deepEqual(corrected.results.map(result => result.variableId), ['tipo_interaccion']);
  assert.deepEqual(corrected.validationErrors, []);
  const request = JSON.parse(retry.calls[0][1].body).body;
  const input = JSON.parse(request.messages.at(-1).content);
  assert.deepEqual(input.variables.map(variable => variable.id), ['tipo_interaccion']);
  assert.deepEqual(input.correccionesFormato, [{ variableId: 'tipo_interaccion', rules: ['unexpected_fields'] }]);
  assert.ok(!JSON.stringify(request).includes(secret));

  raw.results.tipo_interaccion.reason = '';
  const mixed = await flashEvaluator(flashPayload(raw)).instance.evaluate(conversation, variables);
  assert.deepEqual(mixed.results.map(result => result.variableId), ['event']);
  assert.deepEqual(mixed.validationErrors[0].rules, ['invalid_reason', 'unexpected_fields']);
});

test('alternate structured answers cannot bypass refusals, truncation, or tool calls', async () => {
  for (const [change, expected] of [
    [{ refusal: 'Rejected' }, 'AI_SAFETY_REFUSAL'],
    [{ finish_reason: 'content_filter' }, 'AI_SAFETY_REFUSAL'],
    [{ finish_reason: 'length' }, 'AI_INCOMPLETE'],
    [{ tool_calls: [{ id: 'tool-1', function: { name: 'other' } }] }, 'INVALID_AI_RESULT'],
    [{ tool_calls: {} }, 'INVALID_AI_RESULT'],
    [{ function_call: { name: 'other' } }, 'INVALID_AI_RESULT'],
  ]) {
    const response = flashPayload();
    if (change.finish_reason) response.choices[0].finish_reason = change.finish_reason;
    else Object.assign(response.choices[0].message, change);
    await assert.rejects(flashEvaluator(response).instance.evaluate(conversation, variables), code(expected));
  }
  const response = flashPayload(); response.choices[0].message.tool_calls = [];
  assert.equal((await flashEvaluator(response).instance.evaluate(conversation, variables)).results.length, 2);
});
