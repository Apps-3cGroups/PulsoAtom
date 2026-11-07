import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClefDecisionEvaluator, CLEF_DECISION_ADAPTER_VERSION } from '../src/clef-decision-evaluator.js';
import { GatewayApiClient } from '../src/services/gatewayApiClient.js';

const base = { baseUrl: 'http://gateway.test', token: 'SECRET_GATEWAY_TOKEN', portalKey: 'portal-pulso', toolKey: 'gemma', model: 'clef-flash', timeoutMs: 180000 };
const conversation = { id: 'synthetic', country: 'HN', completed: true,
  messages: [{ id: 'm1', actor: 'cliente', text: 'Texto sintético completo.', timestamp: '2026-11-07T10:00:00Z' },
    { id: 'm2', actor: 'humano', text: 'Respuesta sintética completa.', timestamp: '2026-11-07T10:01:00Z' }],
  gemmaResults: 'DO_NOT_SEND_OTHER_MODEL_RESULTS' };
const flag = id => ({ id, name: id, type: 'Flag', method: 'IA', definition: `Definición de ${id}`, condition: '', version: 1 });
const answer = (criteria, choice) => ({ type: 'choice', choice,
  probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === choice ? 1 : 0])), confidence: 0.9 });
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
function fixture({ choose = (_id, question, stage) => stage === 'evidence' ? 'm1' : Object.hasOwn(question.criteria, 'absent') ? 'absent' : 'disponibilidad',
  change, contextLength = 2_000_000, inventoryType = 'decision' } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const invocation = JSON.parse(options.body), index = calls.length;
    calls.push({ url, options, invocation });
    const envelope = { ok: true, tool_key: base.toolKey, method: invocation.method, path: invocation.path,
      upstream_status_code: 200, request_uuid: `request-${index}` };
    if (invocation.path === '/api/v1/models') return json({ ...envelope, response: { models: [{ key: 'provider/clef', type: inventoryType,
      loaded_instances: [{ id: base.model, config: { context_length: contextLength } }] }] } });
    const stage = invocation.caller.operation.endsWith('evidence') ? 'evidence' : 'classification';
    const payload = { model: base.model, answers: Object.fromEntries(Object.entries(invocation.body.questions).map(([id, question]) =>
      [id, answer(question.criteria, choose(id, question, stage))])), usage: { input_tokens: 20, output_tokens: 0 } };
    return change?.({ index, invocation, envelope, payload, stage }) || json({ ...envelope, response: payload });
  };
  return { evaluator: new ClefDecisionEvaluator({ ...base, fetchImpl }), calls, fetchImpl };
}
const inferenceCalls = calls => calls.filter(call => call.invocation.path === '/v1/systemone');

test('native decisions use full context, independent evidence and honest templated provenance', async () => {
  const variables = [flag('positive'), flag('negative'), flag('unknown'),
    { ...flag('tipo_interaccion'), type: 'Descriptor' }, { ...flag('productos_solicitados'), type: 'Descriptor' }];
  const { evaluator, calls } = fixture({ choose: (id, _q, stage) => stage === 'evidence' ? 'm1'
    : ({ positive: 'present', negative: 'absent', unknown: 'insufficient', tipo_interaccion: 'disponibilidad' })[id] });
  const result = await evaluator.evaluate(conversation, variables);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].invocation.path, '/api/v1/models');
  assert.equal(result.protocol, 'systemone');
  assert.equal(result.adapterVersion, CLEF_DECISION_ADAPTER_VERSION);
  assert.match(result.instructionsHash, /^[a-f0-9]{64}$/);
  assert.equal(result.instructionsHash, evaluator.instructionsHash);
  assert.deepEqual(result.requestIds, ['request-0', 'request-1', 'request-2']);
  assert.deepEqual(result.usage, { input_tokens: 40, output_tokens: 0, total_tokens: 40 });
  assert.deepEqual(result.validationErrors, []);
  const byId = Object.fromEntries(result.results.map(r => [r.variableId, r]));
  assert.equal(byId.positive.value, 1);
  assert.equal(byId.positive.reasonSource, 'adapter_template');
  assert.equal(byId.positive.evidenceSource, 'model_choice');
  assert.deepEqual(byId.positive.evidence, [{ messageId: 'm1', quote: conversation.messages[0].text }]);
  assert.equal(byId.negative.value, 0);
  assert.equal(byId.unknown.status, 'no_evaluado');
  assert.equal(byId.tipo_interaccion.value, 'disponibilidad');
  assert.equal(byId.productos_solicitados.status, 'no_evaluado');
  assert.equal(byId.productos_solicitados.unavailabilityCode, 'unsupported_descriptor');
  for (const call of inferenceCalls(calls)) {
    assert.deepEqual(call.invocation.body.state.messages, conversation.messages);
    assert.equal(call.invocation.body.model, 'clef-flash');
    assert.deepEqual(Object.keys(call.invocation.body).sort(), ['model', 'questions', 'state']);
    assert.ok(!JSON.stringify(call.invocation.body).includes('DO_NOT_SEND_OTHER_MODEL_RESULTS'));
    assert.equal(call.options.headers['X-Gateway-Token'], base.token);
  }
  assert.deepEqual(calls[1].invocation.body.state, calls[2].invocation.body.state);
  assert.ok(!JSON.stringify(calls[2].invocation.body).includes('"choice":"present"'));
  assert.ok(!JSON.stringify(result).includes(base.token));
  assert.ok(!JSON.stringify(evaluator).includes(base.token));
});

test('independent evidence can reject a detection without converting it to absence', async () => {
  const { evaluator } = fixture({ choose: (_id, _q, stage) => stage === 'evidence' ? 'none' : 'present' });
  const result = await evaluator.evaluate(conversation, [flag('event')]);
  assert.equal(result.results[0].status, 'no_evaluado');
  assert.equal(result.results[0].value, null);
  assert.deepEqual(result.results[0].evidence, []);
  assert.equal(result.results[0].decision.classification.choice, 'present');
  assert.equal(result.results[0].decision.evidence.choice, 'none');
});

test('category evidence must substantiate its own selected category, without other-model answers', async () => {
  const { evaluator, calls } = fixture({ choose: (_id, question, stage) => {
    if (stage !== 'evidence') return 'disponibilidad';
    assert.match(question.instructions, /Categoría que debe sustentar la evidencia: «disponibilidad»/);
    assert.match(question.instructions, /Un mensaje de otra categoría no es evidencia suficiente/);
    assert.ok(!question.instructions.includes('DO_NOT_SEND_OTHER_MODEL_RESULTS'));
    return 'none';
  } });
  const result = await evaluator.evaluate(conversation, [{ ...flag('tipo_interaccion'), type: 'Descriptor' }]);
  assert.equal(result.results[0].status, 'no_evaluado');
  assert.equal(result.results[0].decision.classification.choice, 'disponibilidad');
  assert.deepEqual(result.validationErrors, []);
  assert.equal(inferenceCalls(calls).length, 2);
});

test('malformed variable decisions keep valid siblings and expose only bounded validation rules', async () => {
  const mutations = [a => { a.type = 'score'; }, a => { a.choice = 'invented'; }, a => { delete a.probabilities.present; },
    a => { a.probabilities.absent = 0.5; }, a => { a.confidence = 2; }, a => { a.probabilities.absent = -1; },
    a => { a.choice = 'present'; }];
  for (const mutate of mutations) {
    const { evaluator, calls } = fixture({ change: ({ payload, envelope }) => { mutate(payload.answers.invalid); return json({ ...envelope, response: payload }); } });
    const result = await evaluator.evaluate(conversation, [flag('valid'), flag('invalid')]);
    assert.deepEqual(result.results.map(r => r.variableId), ['valid']);
    assert.equal(result.validationErrors[0].variableId, 'invalid');
    assert.equal(result.validationErrors[0].code, 'INVALID_AI_RESULT');
    assert.equal(inferenceCalls(calls).length, 1);
  }
  const { evaluator } = fixture({ change: ({ payload, envelope }) => { delete payload.answers.invalid; return json({ ...envelope, response: payload }); } });
  assert.deepEqual((await evaluator.evaluate(conversation, [flag('valid'), flag('invalid')])).validationErrors[0].rules, ['missing_item']);
});

test('invented evidence IDs cannot become evidence; code overrides retain original decision provenance', async () => {
  const broken = fixture({ choose: (_id, _q, stage) => stage === 'evidence' ? 'invented-message' : 'present' });
  const invalid = await broken.evaluator.evaluate(conversation, [flag('event')]);
  assert.equal(invalid.results.length, 0);
  assert.equal(invalid.validationErrors.length, 1);
  const normal = fixture({ choose: (_id, _q, stage) => stage === 'evidence' ? 'm1' : 'present' });
  const changed = (await normal.evaluator.evaluate(conversation, [{ ...flag('asistente_no_respondio_ultimo_mensaje'), method: 'IA + código' }])).results[0];
  assert.equal(changed.value, 0);
  assert.equal(changed.reasonSource, 'code_rule');
  assert.equal(changed.aiResult.value, 1);
  assert.equal(changed.aiResult.reasonSource, 'adapter_template');
  assert.equal(changed.aiResult.evidenceSource, 'model_choice');
});

test('unsupported lists and more than 254 messages abstain without inference or truncation', async () => {
  const { evaluator, calls } = fixture();
  const list = await evaluator.evaluate(conversation, [{ ...flag('productos_solicitados'), type: 'Descriptor' }]);
  assert.equal(list.results[0].value, null);
  const large = { ...conversation, messages: Array.from({ length: 255 }, (_, i) => ({ id: `m${i}`, actor: 'cliente', text: `Mensaje ${i}` })) };
  const oversized = await evaluator.evaluate(large, [flag('event')]);
  assert.equal(oversized.results[0].status, 'no_evaluado');
  assert.equal(oversized.results[0].unavailabilityCode, 'evidence_capacity_exceeded');
  assert.equal(calls.length, 0);
  const boundary = fixture({ choose: (_id, _q, stage) => stage === 'evidence' ? 'm253' : 'present' });
  const supported = { ...large, messages: large.messages.slice(0, 254) };
  const result = await boundary.evaluator.evaluate(supported, [flag('event')]);
  assert.equal(result.results[0].evidence[0].messageId, 'm253');
  assert.equal(Object.keys(boundary.calls[2].invocation.body.questions.event.criteria).length, 255);
  assert.equal(boundary.calls[2].invocation.body.state.messages.length, 254);
});

test('native loaded decision identity and full input capacity are checked before any inference', async () => {
  for (const options of [{ contextLength: 1024 }, { inventoryType: 'llm' }]) {
    const { evaluator, calls } = fixture(options);
    await assert.rejects(evaluator.evaluate(conversation, [flag('event')]), error => ['INPUT_CAPACITY_EXCEEDED', 'AI_CONFIGURATION'].includes(error.code));
    assert.equal(calls.length, 1);
    assert.equal(inferenceCalls(calls).length, 0);
  }
});

test('255-choice probabilities permit four-decimal rounding but reject sums outside that rounding bound', async () => {
  const large = { ...conversation, messages: Array.from({ length: 254 }, (_, i) => ({ id: `m${i}`, actor: 'cliente', text: `Mensaje ${i}` })) };
  for (const probability of [0.0039, 0.0038]) {
    const { evaluator } = fixture({ choose: (_id, _question, stage) => stage === 'evidence' ? 'm253' : 'present',
      change: ({ stage, envelope, payload }) => {
        if (stage !== 'evidence') return null;
        const decision = payload.answers.event;
        decision.probabilities = Object.fromEntries(Object.keys(decision.probabilities).map(key => [key, probability]));
        // Confidence is not required to equal the chosen probability.
        decision.confidence = 0.4;
        return json({ ...envelope, response: payload });
      } });
    const result = await evaluator.evaluate(large, [flag('event')]);
    if (probability === 0.0039) {
      assert.deepEqual(result.validationErrors, []);
      assert.equal(result.results[0].evidence[0].messageId, 'm253');
      assert.equal(result.results[0].decision.evidence.confidence, 0.4);
    } else {
      assert.equal(result.results.length, 0);
      assert.deepEqual(result.validationErrors[0].rules, ['invalid_value_type']);
    }
  }
});

test('130 variables use at most 22 inference requests in chunks of 12 with no own retries', async () => {
  const { evaluator, calls } = fixture({ choose: (_id, _q, stage) => stage === 'evidence' ? 'm1' : 'present' });
  const result = await evaluator.evaluate(conversation, Array.from({ length: 130 }, (_, i) => flag(`event_${i}`)));
  assert.equal(result.results.length, 130);
  assert.equal(inferenceCalls(calls).length, 22);
  assert.ok(inferenceCalls(calls).every(call => Object.keys(call.invocation.body.questions).length <= 12));
  await assert.rejects(evaluator.evaluate(conversation, Array.from({ length: 131 }, (_, i) => flag(`event_${i}`))), error => error.code === 'UNSUPPORTED_VARIABLE');
  assert.equal(calls.length, 23);
});

test('partial technical failures preserve earlier valid results and distinguish intervention from retryable errors', async () => {
  for (const status of [400, 503]) {
    const { evaluator, calls } = fixture({ change: ({ index, envelope }) => index === 2
      ? json({ ...envelope, ok: false, upstream_status_code: status, error: { message: base.token } }, status) : null });
    const result = await evaluator.evaluate(conversation, Array.from({ length: 13 }, (_, i) => flag(`event_${i}`)));
    assert.equal(result.results.length, 12);
    assert.equal(result.validationErrors.length, 1);
    assert.equal(result.failure.code, status === 400 ? 'AI_CONFIGURATION' : 'AI_TRANSIENT');
    assert.equal(result.requests.at(-1).errorCode, result.failure.code);
    assert.equal(calls.length, 3);
    assert.ok(!JSON.stringify(result).includes(base.token));
  }
});

test('missing or changed model, refusal, unknown questions and malformed shape cannot become decisions', async () => {
  const cases = [
    [payload => { delete payload.model; }, 'MODEL_IDENTITY_UNVERIFIED'],
    [payload => { payload.model = 'different-model'; }, 'MODEL_CHANGED'],
    [payload => { payload.refusal = true; }, 'AI_SAFETY_REFUSAL'],
    [payload => { payload.answers.extra = payload.answers.event; }, 'INVALID_AI_RESULT'],
    [payload => { payload.answers = []; }, 'INVALID_AI_RESULT'],
  ];
  for (const [change, code] of cases) {
    const { evaluator, calls } = fixture({ change: ({ payload, envelope }) => { change(payload); return json({ ...envelope, response: payload }); } });
    await assert.rejects(evaluator.evaluate(conversation, [flag('event')]), error => error.code === code && error.evaluationMetadata.requestIds.length === 2);
    assert.equal(calls.length, 2);
  }
});

test('Gateway permits only the two explicit new native operations and rejects arbitrary native access', async () => {
  const calls = [];
  const client = new GatewayApiClient({ ...base, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); calls.push(request);
    return json({ ok: true, tool_key: base.toolKey, method: request.method, path: request.path,
      upstream_status_code: 200, request_uuid: 'native-request', response: {} });
  } });
  await client.invoke({ toolKey: base.toolKey, method: 'POST', path: '/v1/systemone', body: { model: base.model, state: '', questions: {} } });
  await client.invoke({ toolKey: base.toolKey, method: 'GET', path: '/api/v1/models' });
  for (const operation of [{ method: 'POST', path: '/api/v1/models/load' }, { method: 'POST', path: '/api/v1/chat' }, { method: 'GET', path: '/v1/systemone' }]) {
    await assert.rejects(client.invoke({ toolKey: base.toolKey, ...operation }), error => error.code === 'AI_CONFIGURATION');
  }
  assert.equal(calls.length, 2);
});

test('unsupported SystemOne HTTP 501 requires configuration while chat 501 remains transient', async () => {
  for (const transportStatus of [200, 501]) {
    for (const path of ['/v1/systemone', '/v1/chat/completions']) {
      let calls = 0;
      const client = new GatewayApiClient({ ...base, fetchImpl: async () => {
        calls += 1;
        return json({ ok: false, upstream_status_code: 501, error: { message: base.token } }, transportStatus);
      } });
      await assert.rejects(client.invoke({ toolKey: base.toolKey, method: 'POST', path }), error => {
        assert.equal(error.code, path === '/v1/systemone' ? 'AI_CONFIGURATION' : 'AI_TRANSIENT');
        assert.ok(!error.message.includes(base.token));
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});
