import test from 'node:test';
import assert from 'node:assert/strict';
import { initialCatalog } from '../src/data/seed.js';
import { GeminiEvaluator, geminiEvaluationSchema } from '../src/gemini-evaluator.js';
import { evaluationInput, evaluationInstructions, supportsAiVariable, validateEvaluation } from '../src/evaluator.js';

const variables = initialCatalog.filter(v => v.active && supportsAiVariable(v));
const conversation = { id: 'gemini-schema-synthetic', completed: true, messages: [
  { id: 'm1', actor: 'cliente', text: '¿Está disponible Producto A?' },
  { id: 'm2', actor: 'humano', text: 'Voy a revisar la disponibilidad.' },
] };
const response = () => ({ results: variables.map(variable => ({
  variableId: variable.id, status: 'evaluado',
  value: variable.id === 'tipo_interaccion' ? 'disponibilidad' : variable.id === 'productos_solicitados' ? ['Producto A'] : 0,
  reason: 'Resultado sintético con evidencia cuando corresponde.',
  evidence_message_ids: variable.type === 'Descriptor' ? ['m1'] : [],
})) });
function evaluator(raw, observe) {
  return new GeminiEvaluator({ apiKey: 'synthetic-key', baseUrl: 'https://example.test/v1beta', model: 'synthetic-model', fetchImpl: async (url, options) => {
    observe?.(url, options);
    return { ok: true, json: async () => ({ modelVersion: 'synthetic-model', responseId: 'synthetic-response', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(raw) }] } }] }) };
  } });
}

test('Gemini usa una gramática constante para las 49 variables y conserva contenido e instrucciones', async () => {
  assert.equal(variables.length, 49);
  let body;
  const result = await evaluator(response(), (_url, options) => { body = JSON.parse(options.body); }).evaluate(conversation, variables);
  assert.equal(result.results.length, 49); assert.deepEqual(result.validationErrors, []);
  assert.equal(body.systemInstruction.parts[0].text, evaluationInstructions);
  assert.equal(body.contents[0].parts[0].text, evaluationInput(conversation, variables));
  assert.equal(body.generationConfig.responseJsonSchema.properties.results.type, 'array');
  assert.deepEqual(body.generationConfig.responseJsonSchema, geminiEvaluationSchema());
  const variants = body.generationConfig.responseJsonSchema.properties.results.items.anyOf;
  assert.equal(variants.length, 6);
  assert.ok(variants.every(v => [0, 3].includes(v.properties.evidence_message_ids.maxItems)));
  assert.ok(JSON.stringify(body.generationConfig.responseJsonSchema).length < 3000);
  for (const variable of variables) assert.ok(!JSON.stringify(body.generationConfig.responseJsonSchema).includes(variable.id));
  assert.equal(result.results.find(r => r.variableId === 'tipo_interaccion').value, 'disponibilidad');
  assert.deepEqual(result.results.find(r => r.variableId === 'productos_solicitados').value, ['Producto A']);
});

test('un flag y los 49 ítems usan el mismo esquema sin enumerar IDs dinámicos', async () => {
  const selected = variables.filter(v => v.id === 'cliente_molesto');
  const raw = { results: response().results.filter(r => r.variableId === selected[0].id) };
  let body;
  const result = await evaluator(raw, (_url, options) => { body = JSON.parse(options.body); }).evaluate(conversation, selected);
  assert.equal(result.results.length, 1);
  assert.deepEqual(body.generationConfig.responseJsonSchema, geminiEvaluationSchema());
  assert.deepEqual(JSON.parse(body.contents[0].parts[0].text).variables.map(v => v.id), ['cliente_molesto']);
});

test('un ID ausente no descarta los otros 48 resultados y conserva el reintento por variable', async () => {
  const raw = response(); raw.results = raw.results.filter(r => r.variableId !== 'cliente_molesto');
  const answer = await evaluator(raw).evaluate(conversation, variables);
  assert.equal(answer.results.length, 48); assert.equal(answer.validationErrors.length, 1);
  assert.equal(answer.validationErrors[0].variableId, 'cliente_molesto');
  assert.deepEqual(answer.validationErrors[0].rules, ['missing_item']);
});

test('IDs repetidos o ajenos se rechazan y nunca sobrescriben respuestas ni agregan votos', async () => {
  const duplicate = response(); duplicate.results.push({ ...duplicate.results[0], value: 1, evidence_message_ids: ['m1'] });
  await assert.rejects(evaluator(duplicate).evaluate(conversation, variables), { code: 'INVALID_AI_RESULT' });
  const unknown = response(); unknown.results.push({ ...unknown.results[0], variableId: 'variable_no_solicitada' });
  await assert.rejects(evaluator(unknown).evaluate(conversation, variables), { code: 'INVALID_AI_RESULT' });
  const malformed = response(); delete malformed.results[0].variableId;
  await assert.rejects(evaluator(malformed).evaluate(conversation, variables), { code: 'INVALID_AI_RESULT' });
});

test('la normalización conserva la validación estricta de valores, abstenciones y evidencia', async () => {
  const raw = response();
  Object.assign(raw.results.find(r => r.variableId === 'cliente_molesto'), { status: 'no_evaluado', value: null, evidence_message_ids: [] });
  raw.results.find(r => r.variableId === 'tipo_interaccion').value = 'categoria_inventada';
  raw.results.find(r => r.variableId === 'productos_solicitados').value = [123];
  Object.assign(raw.results.find(r => r.variableId === 'cliente_abusivo'), { value: 1, evidence_message_ids: ['mensaje_inventado'] });
  const answer = await evaluator(raw).evaluate(conversation, variables);
  assert.equal(answer.results.length, 46); assert.equal(answer.validationErrors.length, 3);
  assert.equal(answer.results.find(r => r.variableId === 'cliente_molesto').status, 'no_evaluado');
  assert.ok(answer.validationErrors.find(e => e.variableId === 'tipo_interaccion').rules.includes('invalid_value_type'));
  assert.ok(answer.validationErrors.find(e => e.variableId === 'productos_solicitados').rules.includes('invalid_value_type'));
  assert.ok(answer.validationErrors.find(e => e.variableId === 'cliente_abusivo').rules.includes('unknown_evidence_message'));
});

test('flags y descriptores aceptan tres evidencias y mantienen pendientes los ítems con cuatro', async () => {
  const c = { ...conversation, messages: [...conversation.messages,
    { id: 'm3', actor: 'humano', text: 'También está disponible Producto B.' },
    { id: 'm4', actor: 'cliente', text: 'Sí, agregue Producto B, por favor.' },
  ] };
  const selected = variables.filter(v => ['productos_solicitados', 'cliente_acepto_cross_sell'].includes(v.id));
  const raw = { results: response().results.filter(r => selected.some(v => v.id === r.variableId)).map(r => ({ ...r,
    value: r.variableId === 'productos_solicitados' ? ['Producto A', 'Producto B'] : 1,
    evidence_message_ids: ['m1', 'm3', 'm4'],
  })) };
  const accepted = await evaluator(raw).evaluate(c, selected);
  assert.equal(accepted.results.length, 2);
  assert.deepEqual(accepted.validationErrors, []);
  for (const item of raw.results) item.evidence_message_ids = ['m1', 'm2', 'm3', 'm4'];
  const rejected = await evaluator(raw).evaluate(c, selected);
  assert.equal(rejected.results.length, 0);
  assert.equal(rejected.validationErrors.length, 2);
  assert.ok(rejected.validationErrors.every(error => error.rules.includes('invalid_evidence_count')));
});

// Minimal JSON Schema interpreter for the keywords used by this response
// grammar. It tests accepted combinations, independently of the schema builder.
function matchesSchema(value, schema) {
  if (schema.anyOf && !schema.anyOf.some(candidate => matchesSchema(value, candidate))) return false;
  if (schema.enum && !schema.enum.some(candidate => JSON.stringify(candidate) === JSON.stringify(value))) return false;
  if (schema.type) {
    const types = { object: value !== null && typeof value === 'object' && !Array.isArray(value),
      array: Array.isArray(value), string: typeof value === 'string', integer: Number.isInteger(value), null: value === null };
    if (!types[schema.type]) return false;
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.items && !value.every(item => matchesSchema(item, schema.items))) return false;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.required?.some(key => !(key in value))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in (schema.properties || {})))) return false;
    if (Object.entries(schema.properties || {}).some(([key, property]) => key in value && !matchesSchema(value[key], property))) return false;
  }
  return true;
}

test('las variantes coinciden con el contrato común para estado, valor y cantidad de evidencias', () => {
  const c = { ...conversation, messages: [...conversation.messages,
    { id: 'm3', actor: 'humano', text: 'Producto B también está disponible.' },
    { id: 'm4', actor: 'cliente', text: 'Gracias.' },
  ] };
  const cases = [
    { id: 'cliente_acepto_cross_sell', values: [0, 1, null] },
    { id: 'tipo_interaccion', values: ['disponibilidad', null] },
    { id: 'productos_solicitados', values: [[], ['Producto A'], null] },
  ];
  for (const { id, values } of cases) for (const value of values) for (const status of ['evaluado', 'no_evaluado']) for (const count of [0, 1, 2, 3, 4]) {
    const variable = variables.find(v => v.id === id);
    const item = { variableId: id, value, status, reason: 'Caso sintético del contrato.', evidence_message_ids: c.messages.slice(0, count).map(m => m.id) };
    const valid = validateEvaluation({ results: { [id]: item } }, [variable], c, { partial: true }).validationErrors.length === 0;
    assert.equal(matchesSchema({ results: [item] }, geminiEvaluationSchema()), valid, JSON.stringify({ id, value, status, count }));
  }
});

test('evidencia inesperada permanece inválida, sin borrarla ni convertir una respuesta en éxito', async () => {
  const raw = response();
  Object.assign(raw.results.find(r => r.variableId === 'cliente_acepto_cross_sell'), { value: 0, evidence_message_ids: ['m1'] });
  Object.assign(raw.results.find(r => r.variableId === 'cliente_molesto'), { status: 'no_evaluado', value: null, evidence_message_ids: ['m2'] });
  Object.assign(raw.results.find(r => r.variableId === 'productos_solicitados'), { value: [], evidence_message_ids: ['m1'] });
  const snapshot = structuredClone(raw);
  assert.equal(matchesSchema(raw, geminiEvaluationSchema()), false);
  const answer = await evaluator(raw).evaluate(conversation, variables);
  assert.equal(answer.results.length, 46);
  assert.equal(answer.validationErrors.length, 3);
  assert.ok(answer.validationErrors.every(error => error.rules.includes('unexpected_evidence')));
  assert.deepEqual(raw, snapshot);
});
