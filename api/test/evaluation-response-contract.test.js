import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { evaluationInput, evaluationInstructions, evaluationSchema, evaluationValidationFeedback, PROMPT_VERSION, supportsAiVariable, validateEvaluation } from '../src/evaluator.js';
import { GatewayEvaluator } from '../src/gateway-evaluator.js';
import { ModelRegistry } from '../src/model-registry.js';
import { runEvaluationBatch } from '../src/evaluation-service.js';
import { gemmaContractConversation as conversation } from '../src/gemma-contract-check.js';

const flagged = 'asistente_comunicacion_poco_profesional';
const variable = { id: flagged, type: 'Flag', method: 'IA' };
const record = () => ({ status: 'evaluado', value: 0, reason: 'No hay un evento visible de esta variable.', evidence_message_ids: [] });
const validate = change => {
  const item = record(); change(item);
  return validateEvaluation({ results: { [flagged]: item } }, [variable], conversation, { partial: true });
};

test('schema advertises existing reason/evidence limits and instructions are separately versioned', () => {
  const schema = evaluationSchema([variable]).properties.results.properties[flagged].properties;
  assert.deepEqual(schema.reason, { type: 'string', minLength: 1, maxLength: 1000 });
  assert.equal(schema.evidence_message_ids.minItems, 0); assert.equal(schema.evidence_message_ids.maxItems, 3);
  assert.equal(PROMPT_VERSION, 'pulso-audit-v5-contract-2');
  assert.match(evaluationInstructions, /no vacío ni solo espacios/);
  assert.match(evaluationInstructions, /No rellenes todo con 0 ni con no_evaluado/);
});

test('strict validation keeps numeric flag types, reason boundaries and valid abstentions', () => {
  for (const reason of ['', '   ', 12, 'a'.repeat(1001)]) assert.ok(validate(item => { item.reason = reason; }).validationErrors[0].rules.includes('invalid_reason'));
  for (const reason of ['a', 'a'.repeat(1000)]) assert.equal(validate(item => { item.reason = reason; }).validationErrors.length, 0);
  for (const value of ['0', '1', false, 2]) assert.ok(validate(item => { item.value = value; }).validationErrors[0].rules.includes('invalid_value_type'));
  const abstained = validate(item => { item.status = 'no_evaluado'; item.value = null; });
  assert.deepEqual(abstained.validationErrors, []); assert.equal(abstained.results[0].value, null);
  assert.equal(abstained.results[0].status, 'no_evaluado');
  assert.ok(validate(item => { item.status = 'no_evaluado'; }).validationErrors[0].rules.includes('inconsistent_status_value'));
});

test('zero and abstention never accept evidence; positive flags need one to three existing messages', () => {
  for (const ids of ['synthetic-client-1', ['synthetic-client-1', 'synthetic-human-1', 'synthetic-client-2', 'synthetic-human-2']]) {
    assert.ok(validate(item => { item.evidence_message_ids = ids; }).validationErrors[0].rules.includes('invalid_evidence_count'));
  }
  assert.ok(validate(item => { item.evidence_message_ids = ['synthetic-client-1']; }).validationErrors[0].rules.includes('unexpected_evidence'));
  assert.ok(validate(item => { item.value = 1; }).validationErrors[0].rules.includes('missing_evidence'));
  assert.equal(validate(item => { item.value = 1; item.evidence_message_ids = ['synthetic-client-1', 'synthetic-human-1', 'synthetic-client-2']; }).validationErrors.length, 0);
  assert.ok(validate(item => { item.value = 1; item.evidence_message_ids = ['invented']; }).validationErrors[0].rules.includes('unknown_evidence_message'));
});

test('retry input includes only requested variable IDs and allowlisted validation rules, never raw errors', () => {
  const errors = [{ variableId: flagged, rules: ['unexpected_evidence', 'PRIVATE_SECRET', 'unexpected_evidence'],
    message: 'PRIVATE_SECRET', rawResponse: 'PRIVATE_RESPONSE' }, { variableId: 'other', rules: ['invalid_reason'] }];
  const feedback = evaluationValidationFeedback([variable], errors);
  assert.deepEqual(feedback, [{ variableId: flagged, rules: ['unexpected_evidence'] }]);
  const input = evaluationInput(conversation, [variable], { validationErrors: errors });
  assert.deepEqual(JSON.parse(input).correccionesFormato, feedback);
  assert.doesNotMatch(input, /PRIVATE_|rawResponse|message":/);
  assert.equal(JSON.parse(evaluationInput(conversation, [variable])).correccionesFormato, undefined);
});

test('47-item batch retains 45 valid answers and retries only the two observed format failures', async () => {
  const state = createState(false);
  for (const v of state.catalog) if (['conversacion_con_areas_de_mejora', 'conversacion_no_resolvio_necesidad_cliente'].includes(v.id)) v.active = false;
  state.catalogVersions = state.catalog.map(v => ({ id: `${v.id}:${v.version}`, itemId: v.id, version: v.version, snapshot: structuredClone(v) }));
  state.conversations = [{ ...structuredClone(conversation), date: '2026-01-01' }];
  state.settings.aiPolicy = { mode: 'single', primaryId: 'gemma-local', fallbackId: null, version: 1 };
  const ai = state.catalog.filter(v => v.active && supportsAiVariable(v)); assert.equal(ai.length, 47);
  const requests = [];
  const evaluator = new GatewayEvaluator({ baseUrl: 'http://gateway.synthetic', token: 'synthetic-secret', portalKey: 'portal-pulso',
    toolKey: 'gemma', model: 'gemma-synthetic', fetchImpl: async (_, options) => {
      const body = JSON.parse(options.body).body, input = JSON.parse(body.messages.at(-1).content); requests.push(input);
      const results = Object.fromEntries(input.variables.map(v => [v.id, { ...record(),
        value: v.tipo === 'Descriptor' ? v.id === 'tipo_interaccion' ? 'disponibilidad' : ['ProductoPrueba'] : 0,
        reason: `Respuesta sintética ${requests.length <= 6 ? 1 : 2}.`, evidence_message_ids: v.tipo === 'Descriptor' ? ['synthetic-client-1'] : [] }]));
      if (requests.length <= 6) {
        if (results.tipo_interaccion) results.tipo_interaccion.status = 'no_evaluado';
        if (results[flagged]) results[flagged].evidence_message_ids = ['synthetic-human-1'];
        if (results.cliente_molesto) results.cliente_molesto = { ...record(), status: 'no_evaluado', value: null };
      }
      return Response.json({ ok: true, tool_key: 'gemma', request_uuid: `synthetic-attempt-${requests.length}`,
        method: 'POST', path: '/v1/chat/completions', upstream_status_code: 200,
        response: { model: body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }] } });
    } });
  const registry = new ModelRegistry([{ id: 'gemma-local', provider: 'gateway', model: evaluator.model, label: 'Gemma', enabled: true, evaluator }]);
  const store = { async read() { return structuredClone(state); }, async readWithConversations() { return structuredClone(state); },
    async transaction(fn) { const draft = structuredClone(state), result = await fn(draft); Object.assign(state, draft); return structuredClone(result); } };
  const job = await runEvaluationBatch(store, registry, { max: 1 });
  assert.equal(job.status, 'completed'); assert.equal(requests.length, 7);
  assert.deepEqual(requests.slice(0, 6).map(r => r.variables.length), [8, 8, 8, 8, 8, 7]);
  assert.equal(new Set(requests.slice(0, 6).flatMap(r => r.variables.map(v => v.id))).size, 47);
  assert.deepEqual(requests.at(-1).variables.map(v => v.id).sort(), [flagged, 'tipo_interaccion'].sort());
  assert.deepEqual(requests.at(-1).correccionesFormato, [
    { variableId: 'tipo_interaccion', rules: ['inconsistent_status_value'] },
    { variableId: flagged, rules: ['unexpected_evidence'] },
  ]);
  assert.equal(state.attempts[0].validVariableIds.length, 45); assert.equal(state.attempts[1].validVariableIds.length, 2);
  const results = state.evaluations[0].results.filter(r => ai.some(v => v.id === r.variableId));
  assert.equal(results.length, 47); assert.equal(new Set(results.map(r => r.variableId)).size, 47);
  assert.equal(results.find(r => r.variableId === 'cliente_molesto').value, null);
  assert.equal(results.find(r => r.variableId === 'cliente_molesto').status, 'no_evaluado');
  assert.ok(results.filter(r => ![flagged, 'tipo_interaccion', 'cliente_molesto'].includes(r.variableId)).every(r => (r.aiResult || r).reason === 'Respuesta sintética 1.'));
  const hybrid = results.find(r => r.variableId === 'asistente_no_respondio_ultimo_mensaje');
  assert.equal(hybrid.codeRule, 'last-message-not-client');
  assert.equal(hybrid.reason, 'El último mensaje visible no es del cliente.');
  assert.equal(hybrid.aiResult.reason, 'Respuesta sintética 1.');
});
