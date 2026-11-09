import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clefFlashEvaluationSchema } from '../src/services/clefFlashSchema.js';
import { validateEvaluation } from '../src/evaluator.js';

const conversation = { completed: true, messages: [{ id: 'm1', actor: 'cliente', text: 'Consulta sintética.' }] };
const flag = { id: 'event', type: 'Flag', method: 'IA' };
const category = { id: 'tipo_interaccion', type: 'Descriptor', method: 'IA' };
const products = { id: 'productos_solicitados', type: 'Descriptor', method: 'IA' };
const answer = (status, value, evidence_message_ids = []) => ({ status, value, reason: 'Razón sintética.', evidence_message_ids });

// Independent validator for the deliberately small JSON Schema subset used by
// this generator. Unknown keywords fail the test rather than being ignored.
function accepts(schema, value) {
  const keywords = new Set(['type', 'enum', 'anyOf', 'properties', 'required', 'additionalProperties',
    'items', 'minItems', 'maxItems', 'minLength', 'maxLength']);
  for (const key of Object.keys(schema)) assert.ok(keywords.has(key), `Unsupported test schema keyword: ${key}`);
  if (schema.anyOf && !schema.anyOf.some(option => accepts(option, value))) return false;
  if (schema.enum && !schema.enum.some(option => JSON.stringify(option) === JSON.stringify(value))) return false;
  if (schema.type === 'null' && value !== null) return false;
  if (schema.type === 'integer' && !Number.isInteger(value)) return false;
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    if (schema.minLength != null && value.length < schema.minLength) return false;
    if (schema.maxLength != null && value.length > schema.maxLength) return false;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return false;
    if (schema.minItems != null && value.length < schema.minItems) return false;
    if (schema.maxItems != null && value.length > schema.maxItems) return false;
    if (schema.items && value.some(item => !accepts(schema.items, item))) return false;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties || {}, key))) return false;
    if (Object.entries(schema.properties || {}).some(([key, child]) => Object.hasOwn(value, key) && !accepts(child, value[key]))) return false;
  }
  return true;
}
function assertCase(variable, item, expected) {
  const raw = { results: { [variable.id]: item } };
  assert.equal(accepts(clefFlashEvaluationSchema([variable], conversation), raw), expected, JSON.stringify(item));
  const validated = validateEvaluation(raw, [variable], conversation, { partial: true });
  assert.equal(validated.validationErrors.length === 0, expected, JSON.stringify(item));
}

test('flag schema permits exactly present, absent and abstained status/value/evidence combinations', () => {
  for (const status of ['evaluado', 'no_evaluado']) for (const value of [0, 1, null]) {
    for (const evidence of [[], ['m1']]) {
      const expected = status === 'evaluado' && ((value === 0 && evidence.length === 0) || (value === 1 && evidence.length === 1))
        || status === 'no_evaluado' && value === null && evidence.length === 0;
      assertCase(flag, answer(status, value, evidence), expected);
    }
  }
});

test('descriptor schema preserves categories and distinguishes empty products from abstention', () => {
  for (const [item, expected] of [
    [answer('evaluado', 'disponibilidad', ['m1']), true], [answer('evaluado', 'disponibilidad'), false],
    [answer('evaluado', 'invented-category', ['m1']), false], [answer('no_evaluado', null), true],
    [answer('no_evaluado', 'disponibilidad'), false], [answer('evaluado', null), false],
  ]) assertCase(category, item, expected);
  for (const [item, expected] of [
    [answer('evaluado', []), true], [answer('evaluado', [], ['m1']), false],
    [answer('evaluado', ['Producto sintético'], ['m1']), true], [answer('evaluado', ['Producto sintético']), false],
    [answer('no_evaluado', null), true], [answer('no_evaluado', []), false],
    [answer('evaluado', [''], ['m1']), false], [answer('evaluado', ['x'.repeat(301)], ['m1']), false],
  ]) assertCase(products, item, expected);
});

test('schema binds evidence to source IDs and keeps bounded reasons, evidence and required fields', () => {
  assertCase(flag, answer('evaluado', 1, ['invented-id']), false);
  assertCase(flag, answer('evaluado', 1, ['m1', 'm1', 'm1', 'm1']), false);
  assertCase(flag, { ...answer('evaluado', 0), reason: '' }, false);
  assertCase(flag, { ...answer('evaluado', 0), reason: 'x'.repeat(1001) }, false);
  const schema = clefFlashEvaluationSchema([flag], conversation);
  assert.equal(accepts(schema, { results: {} }), false);
  assert.equal(accepts(schema, { results: { event: { ...answer('evaluado', 0), analysis: 'extra' } } }), false);
  assert.equal(accepts(schema, { results: { event: answer('evaluado', 0), unknown: answer('evaluado', 0) } }), false);
  assert.throws(() => clefFlashEvaluationSchema([flag], { messages: [{ id: null }] }), error => error.code === 'INVALID_SOURCE');
});
