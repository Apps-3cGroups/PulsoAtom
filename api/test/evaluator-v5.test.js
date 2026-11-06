import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { evaluationSchema, validateEvaluation, supportsAiVariable, OpenAIEvaluator } from '../src/evaluator.js';
import { GeminiEvaluator } from '../src/gemini-evaluator.js';
import { ModelRegistry } from '../src/model-registry.js';
import { runEvaluationBatch, resumeEvaluationBatch } from '../src/evaluation-service.js';
import { selectedEvaluation, sourceFingerprint, digest } from '../src/evaluation-context.js';
import { comparisonRows, qualityMetrics } from '../src/comparisons.js';
import { AppError } from '../src/errors.js';

const c = { id: 'v5-case', country: 'HN', date: '2026-11-03', completed: true, client: { name: 'Cliente sintético' },
  agent: { id: 'test-agent', name: 'Asesor sintético' }, media: [], topics: [], messages: [
    { id: 'm1', actor: 'cliente', text: 'Necesito consultar este producto.', timestamp: '2026-11-03T15:00:00Z' },
    { id: 'm2', actor: 'bot', text: 'En un momento te atiende una persona.', timestamp: '2026-11-03T15:01:00Z' },
    { id: 'm3', actor: 'humano', text: 'Con gusto revisamos el producto.', timestamp: '2026-11-03T15:04:00Z' },
  ] };
const flagId = 'conversacion_con_areas_de_mejora';
const raw = vars => ({ results: Object.fromEntries(vars.map(v => [v.id, {
  status: 'evaluado', value: v.type === 'Descriptor' ? v.id === 'tipo_interaccion' ? 'disponibilidad' : ['este producto'] : 0,
  reason: 'Resultado sintético para prueba.', evidence_message_ids: v.type === 'Descriptor' ? ['m1'] : [],
}])) });
const parsed = (vars, change) => { const data = raw(vars); change?.(data); return validateEvaluation(data, vars, c, { partial: true }); };
function fixture() {
  const state = createState(false); state.conversations = [structuredClone(c)];
  const store = { async read() { return structuredClone(state); }, async readWithConversations() { return structuredClone(state); }, async transaction(fn) {
    const draft = structuredClone(state); const result = await fn(draft); Object.assign(state, draft); return structuredClone(result);
  } };
  return { state, store };
}
const models = (first, second = first) => new ModelRegistry([first, second].map((fn, i) => ({
  id: `v5-${i}`, provider: 'demo', model: `synthetic-v5-${i}`, label: i ? 'Gemini demo' : 'GPT demo', enabled: true,
  evaluator: { configured: true, async evaluate(conversation, vars) { return { ...await fn(vars, conversation), model: `synthetic-v5-${i}` }; } },
})));
const dual = state => { state.settings.aiPolicy = { mode: 'dual', primaryId: 'v5-0', secondaryId: 'v5-1', version: 1 }; };

test('v5 define 49 entradas de IA y distingue categoría, lista y flag', () => {
  const vars = createState(false).catalog.filter(v => v.active && supportsAiVariable(v));
  assert.equal(vars.length, 49);
  const schema = evaluationSchema(vars).properties.results.properties;
  assert.deepEqual(schema[flagId].properties.value.enum, [0, 1, null]);
  assert.ok(schema.tipo_interaccion.properties.value.enum.includes('disponibilidad'));
  assert.deepEqual(schema.productos_solicitados.properties.value.type, ['array', 'null']);
  const result = parsed(vars); assert.equal(result.validationErrors.length, 0);
  assert.equal(result.results.find(r => r.variableId === 'tipo_interaccion').value, 'disponibilidad');
  assert.deepEqual(result.results.find(r => r.variableId === 'productos_solicitados').value, ['este producto']);
});

test('un ítem inválido conserva los válidos y describe la restricción sin guardar el texto crudo', () => {
  const vars = createState(false).catalog.filter(v => v.active && supportsAiVariable(v));
  const result = parsed(vars, data => { data.results[flagId] = { status: 'evaluado', value: 1, reason: 'No publicar respuesta cruda privada.', evidence_message_ids: ['fake'] }; });
  assert.equal(result.results.length, 48); assert.equal(result.validationErrors.length, 1);
  assert.deepEqual(result.validationErrors[0].rules, ['unknown_evidence_message']);
  assert.doesNotMatch(JSON.stringify(result.validationErrors), /privada|fake/);
  assert.ok(!result.results.some(r => r.variableId === flagId));
});

test('OpenAI y Gemini devuelven resultados válidos junto a los errores por variable', async () => {
  const vars = createState(false).catalog.filter(v => v.active && supportsAiVariable(v));
  const data = raw(vars); data.results[flagId].evidence_message_ids = ['m1'];
  const openai = new OpenAIEvaluator({ apiKey: 'synthetic', baseUrl: 'https://example.test', model: 'synthetic', fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(data) }] }] }) }) });
  const gemini = new GeminiEvaluator({ apiKey: 'synthetic', baseUrl: 'https://example.test', model: 'synthetic', fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ results: Object.entries(data.results).map(([variableId, result]) => ({ variableId, ...result })) }) }] } }] }) }) });
  for (const evaluator of [openai, gemini]) {
    const answer = await evaluator.evaluate(c, vars);
    assert.equal(answer.results.length, 48);
    assert.deepEqual(answer.validationErrors[0].rules, ['unexpected_evidence']);
  }
});

test('fase 1 completa conserva métricas, descriptores y abstenciones sin inflar acuerdo', async () => {
  const { state, store } = fixture(); dual(state); const seen = [];
  const fn = vars => { seen.push(vars.map(v => v.id)); return parsed(vars, data => { for (const id of [flagId, 'sentimiento_cliente_mejoro']) data.results[id] = { status: 'evaluado', value: 1, reason: 'Evento sintético.', evidence_message_ids: ['m1'] }; }); };
  const job = await runEvaluationBatch(store, models(fn), { max: 1 });
  assert.equal(job.status, 'completed'); assert.deepEqual(seen[0], seen[1]);
  assert.equal(seen[0].length, 49);
  const evaluation = selectedEvaluation(state, c);
  assert.equal(evaluation.results.length, 64);
  assert.equal(evaluation.results.find(r => r.variableId === flagId).comparison.detections, 2);
  assert.equal(evaluation.results.find(r => r.variableId === 'sentimiento_cliente_mejoro').comparison.detections, 2);
  for (const id of ['num_mensajes_cliente', 'ratio_mensajes_asistente_entre_cliente', 'tipo_interaccion', 'productos_solicitados']) assert.equal(evaluation.results.find(r => r.variableId === id).comparison, undefined);
  assert.equal(evaluation.results.find(r => r.variableId === 'num_mensajes_cliente').value, 1);
  assert.equal(evaluation.results.find(r => r.variableId === 'primera_respuesta_humano_mayor_5_min').status, 'no_evaluado');
});

test('reintenta solo ítems inválidos y reanuda sin repetir los válidos ni al segundo modelo', async () => {
  const { state, store } = fixture(); dual(state); let invalid = true; const requested = [], second = [];
  const registry = models(vars => { requested.push(vars.map(v => v.id)); return parsed(vars, data => {
    if (invalid) data.results[flagId] = { status: 'evaluado', value: 1, reason: 'Hallazgo sintético.', evidence_message_ids: ['inexistente'] };
  }); }, vars => { second.push(vars.map(v => v.id)); return parsed(vars); });
  const job = await runEvaluationBatch(store, registry, { max: 1 });
  assert.equal(job.status, 'partial'); assert.equal(job.completed, 1); assert.equal(job.partial, 1);
  assert.equal(requested[0].length, 49); assert.deepEqual(requested[1], [flagId]); assert.equal(second.length, 1);
  const previous = structuredClone(state.evaluations);
  const partial = selectedEvaluation(state, c).results.find(r => r.variableId === flagId);
  assert.equal(partial.value, null); assert.equal(partial.comparison.votes, 1); assert.equal(partial.comparison.agreement, 'incomplete');
  assert.equal(partial.comparison.cells[0].error.code, 'INVALID_AI_RESULT');
  invalid = false;
  const resumed = await resumeEvaluationBatch(store, registry, job.id); await resumed.completion;
  assert.deepEqual(requested[2], [flagId]); assert.equal(second.length, 1);
  assert.deepEqual(state.evaluations.slice(0, previous.length), previous);
  assert.equal(selectedEvaluation(state, c).results.find(r => r.variableId === flagId).comparison.votes, 2);
  assert.equal(state.tasks.find(t => t.profile.id === 'v5-0').status, 'completed');
});

test('las métricas calculadas sobreviven a un fallo técnico total de IA sin votos falsos', async () => {
  const { state, store } = fixture(); dual(state);
  const fail = () => { throw new AppError(502, 'Sin conexión sintética.', 'AI_TRANSIENT'); };
  const job = await runEvaluationBatch(store, models(fail), { max: 1 });
  assert.equal(job.status, 'partial'); assert.equal(job.partial, 2);
  const evaluation = selectedEvaluation(state, c);
  assert.equal(evaluation.results.find(r => r.variableId === 'num_mensajes_cliente').value, 1);
  const flag = evaluation.results.find(r => r.variableId === flagId);
  assert.equal(flag.value, null); assert.equal(flag.comparison.votes, 0); assert.equal(flag.comparison.cells[0].error.code, 'AI_TRANSIENT');
});

test('comparación excluye métricas, cálculos y descriptores y separa errores de abstenciones', async () => {
  const { state, store } = fixture();
  const registry = models(vars => parsed(vars, data => { delete data.results[flagId]; }));
  await runEvaluationBatch(store, registry, { purpose: 'comparison', modelIds: ['v5-0', 'v5-1'], max: 1 });
  const sample = state.comparisons[0], rows = comparisonRows(state, sample);
  assert.equal(rows.length, 47); assert.ok(rows.every(r => !['Código', 'Cálculo'].includes(r.variable.method)));
  const metrics = qualityMetrics(rows, sample.modelProfiles);
  assert.equal(metrics[0].missing, 1); assert.equal(metrics[0].abstained, 0);
  assert.equal(rows.find(r => r.variable.id === flagId).votes, 0);
  const evaluation = state.evaluations[0]; evaluation.catalogHash = 'not-equivalent';
  assert.ok(comparisonRows(state, sample).every(r => r.cells[0].result === null));
});

test('el respaldo no mezcla sus respuestas con los ítems parciales del principal', async () => {
  const { state, store } = fixture(); state.settings.aiPolicy = { primaryId: 'v5-0', fallbackId: 'v5-1', version: 1 };
  const sizes = [];
  const registry = models(vars => parsed(vars, data => { delete data.results[flagId]; }), vars => { sizes.push(vars.length); return parsed(vars); });
  const job = await runEvaluationBatch(store, registry, { max: 1 });
  assert.equal(job.status, 'completed'); assert.deepEqual(sizes, [49]);
  assert.equal(state.evaluations[0].profileId, 'v5-1'); assert.equal(state.evaluations[0].usedFallback, true);
  assert.equal(state.tasks[0].profileStates['v5-0'].results.length, 48);
  assert.equal(state.attempts.length, 3);
});

test('las huellas históricas siguen estables y nuevos metadatos evaluables invalidan equivalencia', () => {
  const previous = digest({ id: c.id, country: c.country, completed: c.completed,
    messages: c.messages.map(m => ({ id: m.id, actor: m.actor, text: m.text, timestamp: m.timestamp })) });
  assert.equal(sourceFingerprint(c), previous);
  const enriched = { ...c, messageAgentIdsAvailable: true, messages: c.messages.map(m => ({ ...m, agentId: m.actor === 'humano' ? 'agent-1' : null })) };
  assert.notEqual(sourceFingerprint(enriched), previous);
  const changed = structuredClone(enriched); changed.messages[2].agentId = 'agent-2';
  assert.notEqual(sourceFingerprint(changed), sourceFingerprint(enriched));
  assert.notEqual(sourceFingerprint({ ...c, buttonEventsAvailable: true, offeredButtons: [{ id: 'a', label: 'A' }], selectedButtonIds: [] }), previous);
});

test('reanudar con instrucciones antiguas se rechaza antes de mutar el lote o llamar a IA', async () => {
  const { state, store } = fixture(); dual(state); let calls = 0;
  const registry = models(vars => { calls++; return parsed(vars, data => { delete data.results[flagId]; }); });
  const job = await runEvaluationBatch(store, registry, { max: 1 });
  state.tasks[0].context.rulesVersion = 'previous-rules';
  const before = JSON.stringify(state), previousCalls = calls;
  await assert.rejects(resumeEvaluationBatch(store, registry, job.id), { code: 'PROMPT_CHANGED' });
  assert.equal(JSON.stringify(state), before); assert.equal(calls, previousCalls);
});

test('tener métricas calculadas no evita la intervención requerida por rechazo de seguridad', async () => {
  const { state, store } = fixture(); dual(state);
  const registry = models(() => { throw new AppError(422, 'Rechazo sintético.', 'AI_SAFETY_REFUSAL'); }, vars => parsed(vars));
  const job = await runEvaluationBatch(store, registry, { max: 1 });
  assert.equal(job.status, 'partial');
  assert.equal(state.operationalRefs.length, 0);
  assert.ok(state.evaluations.find(e => e.requestedProfileId === 'v5-0').results.some(r => r.variableId === 'num_mensajes_cliente' && r.value === 1));
});
