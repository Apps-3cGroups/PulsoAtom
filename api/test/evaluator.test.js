import test from 'node:test';
import assert from 'node:assert/strict';
import { initialCatalog } from '../src/data/seed.js';
import { OpenAIEvaluator, evaluationSchema, validateEvaluation } from '../src/evaluator.js';
import { eligibleConversations, runEvaluationBatch } from '../src/evaluation-service.js';
import { createState } from '../src/data/seed.js';
import { evaluateCodeVariable } from '../src/code-evaluator.js';

const variables = initialCatalog.filter(v => v.active);
const conversation = { id: 'atom-1', date: '2026-10-27', messages: [{ id: 'm1', actor: 'cliente', text: 'Voy a cancelar mi pedido.' }, { id: 'm2', actor: 'humano', text: 'Revisaré el estado.' }] };
const answer = () => ({ results: Object.fromEntries(variables.map(v => [v.id, { status: 'evaluado', value: v.id === 'cliente_amenazo_cancelar' ? 1 : 0, reason: 'Según los mensajes.', evidence_message_ids: v.id === 'cliente_amenazo_cancelar' ? ['m1'] : [] }])) });

test('la solicitud usa Responses API, JSON Schema estricto y no guarda la respuesta en OpenAI', async () => {
  let request;
  const evaluator = new OpenAIEvaluator({ apiKey: 'test', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna',
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ id: 'resp-1', status: 'completed', model: 'gpt-6-luna', output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer()) }] }] }) }; } });
  const result = await evaluator.evaluate(conversation, variables);
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(body.store, false);
  assert.match(body.instructions, /cédula y dirección completa pueden ser necesarias para una compra o entrega/);
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(body.text.format.schema.required, ['results']);
  assert.equal(Object.keys(evaluationSchema(variables).properties.results.properties).length, 12);
  assert.equal(result.results.find(r => r.variableId === 'cliente_amenazo_cancelar').evidence[0].quote, 'Voy a cancelar mi pedido.');
});

test('no acepta IDs de evidencia inventados ni resultados incompletos', () => {
  const invalid = answer(); invalid.results.cliente_amenazo_cancelar.evidence_message_ids = ['inventado'];
  assert.throws(() => validateEvaluation(invalid, variables, conversation), { code: 'INVALID_AI_RESULT' });
  delete invalid.results.cliente_amenazo_cancelar;
  assert.throws(() => validateEvaluation(invalid, variables, conversation), { code: 'INVALID_AI_RESULT' });
});

test('la regla de código evita marcar falta de respuesta si el último mensaje no es del cliente', () => {
  const raw = answer();
  raw.results.asistente_no_respondio_ultimo_mensaje = { status: 'evaluado', value: 1, reason: 'El cliente escribió.', evidence_message_ids: ['m1'] };
  const result = validateEvaluation(raw, variables, conversation).find(r => r.variableId === 'asistente_no_respondio_ultimo_mensaje');
  assert.equal(result.value, 0); assert.deepEqual(result.evidence, []);
});

test('cuenta únicamente mensajes del cliente y combina código con la evaluación de IA', async () => {
  const metric = initialCatalog.find(v => v.id === 'num_mensajes_cliente');
  const withMetric = { ...metric, active: true };
  assert.equal(evaluateCodeVariable({ messages: [{ actor: 'cliente' }, { actor: 'bot' }, { actor: 'humano' }, { actor: 'cliente' }] }, withMetric).value, 2);
  assert.equal(evaluateCodeVariable({ messages: [{ actor: 'humano' }] }, withMetric).value, 0);
  const state = createState(false);
  state.catalog = state.catalog.map(v => v.id === metric.id ? withMetric : v);
  state.conversations = [{ ...conversation, completed: true }];
  const store = { async readWithConversations() { return structuredClone(state); }, async read() { return structuredClone(state); }, async transaction(fn) { return fn(state); } };
  const evaluator = { configured: true, async evaluate(_conversation, selected) {
    assert.equal(selected.length, 12);
    assert.ok(selected.every(v => v.method !== 'Código'));
    return { results: validateEvaluation(answer(), selected, conversation), model: 'test-model', responseId: 'test-response' };
  } };
  const job = await runEvaluationBatch(store, evaluator, { max: 1 });
  assert.equal(job.status, 'completed');
  assert.equal(state.evaluations[0].results.length, 13);
  assert.equal(state.evaluations[0].results.find(result => result.variableId === metric.id).value, 1);
  assert.equal(state.evaluations[0].catalogVersions.find(v => v.id === metric.id).active, true);
});

test('el lote histórico selecciona pendientes y guarda solo evaluaciones propias', async () => {
  const state = createState(false);
  state.conversations = [conversation, { ...conversation, id: 'atom-2', date: '2026-10-26', evaluationId: 'old' }];
  const store = {
    async readWithConversations() { return structuredClone(state); }, async read() { return structuredClone(state); },
    async transaction(fn) { return fn(state); },
  };
  const evaluator = { configured: true, async evaluate() { return { results: validateEvaluation(answer(), variables, conversation), model: 'gpt-6-luna', responseId: 'resp-1' }; } };
  assert.deepEqual(eligibleConversations(state).map(c => c.id), ['atom-1']);
  assert.deepEqual(eligibleConversations({ conversations: [{ ...conversation, completed: false }] }), []);
  const job = await runEvaluationBatch(store, evaluator, { max: 5 });
  assert.equal(job.status, 'completed'); assert.equal(job.completed, 1);
  assert.equal(state.evaluations.length, 1);
  assert.equal(state.evaluations[0].catalogVersions.length, 130);
  assert.equal(state.evaluations[0].results.length, 12);
  assert.deepEqual(state.conversations, [conversation, { ...conversation, id: 'atom-2', date: '2026-10-26', evaluationId: 'old' }]);
  const recheck = await runEvaluationBatch(store, evaluator, { conversationIds: ['atom-1'], pendingOnly: false, sourceJobId: job.id, max: 5 });
  assert.deepEqual(recheck.conversationIds, ['atom-1']);
  assert.equal(recheck.scope, 'recheck');
  assert.equal(state.evaluations.length, 2);
});

test('un lote por país incluye solo conversaciones pendientes del país solicitado', async () => {
  const state = createState(false);
  state.conversations = [
    { ...conversation, id: 'hn-1', country: 'HN' },
    { ...conversation, id: 'cr-1', country: 'CR' },
    { ...conversation, id: 'hn-2', country: 'HN', evaluationId: 'old' },
  ];
  const store = { async readWithConversations() { return structuredClone(state); }, async read() { return structuredClone(state); }, async transaction(fn) { return fn(state); } };
  const evaluator = { configured: true, async evaluate() { return { results: validateEvaluation(answer(), variables, conversation), model: 'gpt-6-luna', responseId: 'resp-1' }; } };
  assert.deepEqual(eligibleConversations(state, { country: 'HN' }).map(c => c.id), ['hn-1']);
  const job = await runEvaluationBatch(store, evaluator, { country: 'HN', max: 10 });
  assert.deepEqual(job.conversationIds, ['hn-1']);
  assert.equal(job.country, 'HN');
  assert.equal(job.completed, 1);
});

test('un lote recupera trabajos vencidos y no publica detalles internos de fallos', async () => {
  const state = createState(false);
  state.conversations = [conversation];
  state.jobs.push({ id: 'old-job', status: 'running', createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' });
  const store = { async readWithConversations() { return structuredClone(state); }, async read() { return structuredClone(state); }, async transaction(fn) { return fn(state); } };
  const evaluator = { configured: true, async evaluate() { throw new Error('SQL con texto privado de prueba'); } };
  const job = await runEvaluationBatch(store, evaluator, { max: 1 });
  assert.equal(state.jobs[0].status, 'interrupted');
  assert.equal(job.status, 'failed');
  assert.equal(job.errors[0].code, 'EVALUATION_FAILED');
  assert.equal(job.errors[0].message, 'No se pudo completar esta evaluación.');
});
