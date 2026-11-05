import test from 'node:test';
import assert from 'node:assert/strict';
import { createState as freshState } from '../src/data/seed.js';
import { readFileSync } from 'node:fs';
import { ModelRegistry } from '../src/model-registry.js';
import { startEvaluationBatch, runEvaluationBatch, resumeEvaluationBatch } from '../src/evaluation-service.js';
import { ensureEvaluationState, exposeEvaluation, historicalProfileId } from '../src/evaluation-context.js';
import { comparisonRows, qualityMetrics, validationView, saveValidation } from '../src/comparisons.js';
import { recordReview, conversationView, viewContext } from '../src/domain.js';
import { GeminiEvaluator } from '../src/gemini-evaluator.js';
import { AppError } from '../src/errors.js';

const user = { id: 'validator', name: 'Supervisora' };
const legacyCatalog = JSON.parse(readFileSync(new URL('../src/data/catalog-legacy.json', import.meta.url)));
function createState(demo = false) {
  if (demo) return freshState(true);
  const state = freshState(false);
  state.catalog = structuredClone(legacyCatalog);
  state.catalogVersions = state.catalog.map(v => ({ id: `${v.id}:${v.version}`, itemId: v.id, version: v.version, snapshot: structuredClone(v) }));
  return state;
}
function fixture() {
  const state = createState(false);
  const c = { id: 'c1', country: 'HN', countryName: 'Honduras', date: '2026-10-20', completed: true,
    client: { name: 'Cliente de prueba' }, agent: { id: 'agent', name: 'Asesor' }, media: [], topics: [],
    messages: [{ id: 'm1', actor: 'cliente', text: 'Quiero cancelar mi pedido.', timestamp: '2026-10-20T15:00:00Z' }] };
  state.conversations = [c];
  const store = { async read() { return structuredClone(state); }, async readWithConversations() { return structuredClone(state); }, async transaction(fn) {
    const draft = structuredClone(state); const result = await fn(draft); Object.assign(state, draft); return structuredClone(result);
  } };
  return { state, store, c };
}
const answer = (c, variables, value = 0) => ({ model: 'model', results: variables.map(v => ({ variableId: v.id, method: v.method,
  status: value === null ? 'no_evaluado' : 'evaluado', value, reason: 'Evidencia de prueba.', evidence: value ? [{ messageId: c.messages[0].id, quote: c.messages[0].text }] : [] })) });
function registry(first, second) {
  return new ModelRegistry([first, second].map((fn, i) => ({ id: `model-${i}`, label: `Modelo ${i}`, model: `exact-${i}`, provider: i ? 'gemini' : 'openai', enabled: true,
    evaluator: { configured: true, baseUrl: `https://example.test/${i}`, async evaluate(c, v) { return { ...(await fn(c, v)), model: `exact-${i}` }; } } })));
}
async function compare(store, models, extra = {}) {
  const job = await runEvaluationBatch(store, models, { purpose: 'comparison', modelIds: ['model-0', 'model-1'], max: 1, ...extra });
  return job;
}

test('comparar preserva la operación y entrega el mismo contenido y checklist a ambos modelos', async () => {
  const { state, store, c } = fixture(); const inputs = [];
  const models = registry((c, v) => { inputs.push(JSON.stringify([c.messages, v])); return answer(c, v, 1); }, (c, v) => { inputs.push(JSON.stringify([c.messages, v])); return answer(c, v, 0); });
  state.settings.aiPolicy = { primaryId: 'model-0', fallbackId: null, version: 1 };
  await runEvaluationBatch(store, models, { max: 1 });
  const officialId = state.operationalRefs[0].evaluationId;
  const sample = await compare(store, models); const sampleState = state.comparisons[0];
  assert.equal(inputs[1], inputs[2]); assert.equal(state.operationalRefs[0].evaluationId, officialId);
  assert.equal(conversationView(state, c, undefined, true).evaluation.id, officialId);
  assert.equal(sample.completed, 2); assert.equal(sample.caseCount, 1);
  const row = comparisonRows(state, sampleState)[0];
  assert.equal(row.detections, 1); assert.equal(row.votes, 2); assert.equal(row.agreement, 'disagreement');
  const second = state.evaluations.find(e => e.profileId === 'model-1');
  assert.equal(conversationView(state, c, viewContext(state, historicalProfileId(second)), true).evaluation.id, second.id);
});

test('contingencia hace dos intentos principales y registra al respaldo como autor efectivo', async () => {
  const { state, store } = fixture(); let calls = 0;
  const models = registry(() => { calls++; throw new AppError(502, 'Servicio temporalmente no disponible.', 'AI_TRANSIENT'); }, (c, v) => answer(c, v));
  state.settings.aiPolicy = { primaryId: 'model-0', fallbackId: 'model-1', version: 1 };
  const job = await runEvaluationBatch(store, models, { max: 1 });
  assert.equal(job.completed, 1); assert.equal(calls, 2); assert.equal(state.attempts.length, 3);
  assert.equal(state.evaluations[0].profileId, 'model-1'); assert.equal(state.evaluations[0].usedFallback, true);
  assert.equal(state.evaluations[0].requestedProfileId, 'model-0');
});

test('comparaciones no sustituyen motores fallidos y no convierten el fallo en cero', async () => {
  const { state, store } = fixture();
  const models = registry(() => { throw new AppError(502, 'No disponible.', 'AI_TRANSIENT'); }, (c, v) => answer(c, v, 1));
  state.settings.aiPolicy = { primaryId: 'model-0', fallbackId: 'model-1', version: 1 };
  const job = await compare(store, models);
  assert.equal(job.status, 'partial'); assert.equal(state.evaluations.length, 1);
  const row = comparisonRows(state, state.comparisons[0])[0];
  assert.equal(row.cells[0].result, null); assert.equal(row.detections, 1); assert.equal(row.votes, 1); assert.equal(row.agreement, 'incomplete');
});

test('rechazos de seguridad y errores de configuración no activan respaldo; abstención válida es un éxito', async () => {
  for (const code of ['AI_SAFETY_REFUSAL', 'AI_CONFIGURATION']) {
    const { state, store } = fixture();
    const models = registry(() => { throw new AppError(422, 'No evaluable.', code); }, () => assert.fail('No debe usar el respaldo'));
    state.settings.aiPolicy = { primaryId: 'model-0', fallbackId: 'model-1', version: 1 };
    const job = await runEvaluationBatch(store, models, { max: 1 });
    assert.equal(job.failed, 1); assert.equal(state.attempts.length, 1);
  }
  const { state, store } = fixture();
  const models = registry((c, v) => answer(c, v, null), () => assert.fail('No debe sustituir abstenciones'));
  state.settings.aiPolicy = { primaryId: 'model-0', fallbackId: 'model-1', version: 1 };
  assert.equal((await runEvaluationBatch(store, models, { max: 1 })).completed, 1);
  assert.equal(state.attempts.length, 1);
});

test('reanudación conserva éxitos, comprueba huella y no repite modelos ya completados', async () => {
  const { state, store, c } = fixture(); let fail = true, successfulCalls = 0;
  const models = registry((c, v) => { successfulCalls++; return answer(c, v); }, (c, v) => { if (fail) throw new AppError(502, 'Falló.', 'AI_TRANSIENT'); return answer(c, v); });
  const job = await compare(store, models);
  state.conversations[0].messages[0].text += ' Texto nuevo.';
  await assert.rejects(resumeEvaluationBatch(store, models, job.id), { code: 'SOURCE_CHANGED' });
  state.conversations[0].messages[0].text = c.messages[0].text;
  fail = false;
  const resumed = await resumeEvaluationBatch(store, models, job.id); assert.equal(resumed.job.status, 'running'); await resumed.completion;
  assert.equal(successfulCalls, 1); assert.equal(state.evaluations.length, 2);
});

test('idempotencia devuelve la misma muestra y no repite solicitudes de IA', async () => {
  const { state, store } = fixture(); let calls = 0;
  const models = registry((c, v) => { calls++; return answer(c, v); }, (c, v) => { calls++; return answer(c, v); });
  const options = { purpose: 'comparison', modelIds: ['model-0', 'model-1'], max: 1, idempotencyKey: 'test-key' };
  const first = await startEvaluationBatch(store, models, options); await first.completion;
  const second = await startEvaluationBatch(store, models, options); await second.completion;
  assert.equal(first.job.id, second.job.id); assert.equal(calls, 2); assert.equal(state.comparisons.length, 1);
});

test('validación no filtra predicciones; dictamen común modifica seguimiento sin alterar las respuestas', async () => {
  const { state, store, c } = fixture();
  const models = registry((c, v) => answer(c, v, 1), (c, v) => answer(c, v, 1));
  state.settings.aiPolicy = { primaryId: 'model-0', fallbackId: null, version: 1 };
  await runEvaluationBatch(store, models, { max: 1 }); await compare(store, models);
  const sample = state.comparisons[0]; const before = JSON.stringify(state.evaluations);
  const view = validationView(state, sample, c.id, user);
  assert.equal(view.mode, 'blind');
  assert.doesNotMatch(JSON.stringify(view), /"(?:results?|cells|evidence|models?|verdict)":/);
  const input = { items: view.variables.map(v => ({ variableId: v.id, expectedVerdictId: null, outcome: 'absent', comment: 'El evento no está en el texto.' })) };
  saveValidation(state, sample, c.id, input, user);
  assert.equal(JSON.stringify(state.evaluations), before);
  const official = conversationView(state, c, undefined, true);
  assert.equal(official.p1, 0); assert.equal(official.p2, 0); assert.ok(official.refuted > 0);
  const rows = comparisonRows(state, sample); const metrics = qualityMetrics(rows, sample.modelProfiles);
  assert.equal(metrics[0].precision, 0); assert.equal(metrics[0].recall, null); assert.ok(metrics[0].n > 0);
  const exposedView = validationView(state, sample, c.id, user);
  assert.equal(exposedView.mode, 'assisted');
  assert.throws(() => saveValidation(state, sample, c.id, input, user), { code: 'VERSION_CONFLICT' });
});

test('exposición previa etiqueta revisión asistida y la excluye de métricas a ciegas', async () => {
  const { state, store, c } = fixture();
  const models = registry((c, v) => answer(c, v), (c, v) => answer(c, v));
  await compare(store, models); const sample = state.comparisons[0];
  exposeEvaluation(state, user.id, state.evaluations[0]);
  const view = validationView(state, sample, c.id, user);
  assert.equal(view.mode, 'assisted');
  saveValidation(state, sample, c.id, { items: view.variables.map(v => ({ variableId: v.id, expectedVerdictId: null, outcome: 'present', comment: 'Se identifica un evento omitido.', messageId: 'm1' })) }, user);
  assert.equal(qualityMetrics(comparisonRows(state, sample), sample.modelProfiles)[0].n, 0);
});

test('los resultados heredados conservan referencia operativa y no pasan a ser comparaciones', () => {
  const state = createState(true); const legacy = state.evaluations[0];
  state.evaluations.push({ ...legacy, id: 'new-comparison', purpose: 'comparison', createdAt: '2099-01-01' });
  ensureEvaluationState(state);
  assert.equal(state.operationalRefs.find(r => r.id === legacy.conversationId).evaluationId, legacy.id);
});

test('Gemini utiliza el mismo contrato JSON, API key en header y valida evidencia', async () => {
  const { state, c } = fixture(); const vars = state.catalog.filter(v => v.active); let request;
  const raw = { results: Object.fromEntries(vars.map(v => [v.id, { status: 'evaluado', value: 0, reason: 'No se observa el evento.', evidence_message_ids: [] }])) };
  const model = new GeminiEvaluator({ apiKey: 'test-key', baseUrl: 'https://gemini.example/v1beta', model: 'test-model', fetchImpl: async (url, options) => {
    request = { url, options }; return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(raw) }] } }], modelVersion: 'exact-test-model' }) };
  } });
  const result = await model.evaluate(c, vars);
  assert.equal(request.options.headers['x-goog-api-key'], 'test-key'); assert.ok(!request.url.includes('test-key'));
  assert.equal(JSON.parse(request.options.body).generationConfig.responseMimeType, 'application/json');
  assert.equal(result.results.length, vars.length); assert.equal(result.model, 'exact-test-model');
});

test('un cambio de Atom entre modelos impide continuar con el contenido anterior', async () => {
  const { state, store } = fixture(); let secondCalls = 0;
  const models = registry(async (c, v) => { await store.transaction(s => { s.conversations[0].messages[0].text += ' Cambio en origen.'; }); return answer(c, v); }, (c, v) => { secondCalls++; return answer(c, v); });
  const job = await compare(store, models);
  assert.equal(secondCalls, 0); assert.equal(job.status, 'failed'); assert.equal(state.evaluations.length, 0); assert.equal(job.errors[0].code, 'SOURCE_CHANGED');
  assert.ok(comparisonRows(state, state.comparisons[0]).every(row => row.sourceChanged));
});

test('las reglas híbridas comunes y las métricas de código no inflan los votos', async () => {
  const { state, store } = fixture();
  state.catalog.find(v => v.id === 'num_mensajes_cliente').active = true;
  const corrected = (c, vars) => { const response = answer(c, vars); response.results[0] = { ...response.results[0], codeRule: 'shared-rule', aiResult: { value: 1, reason: 'Original', evidence: [] } }; return response; };
  await compare(store, registry(corrected, corrected));
  const sample = state.comparisons[0], rows = comparisonRows(state, sample);
  assert.equal(sample.cases[0].codeResults[0].value, 1);
  assert.ok(rows.every(r => r.variable.method !== 'Código'));
  assert.equal(rows[0].votes, 0); assert.equal(rows[0].agreement, 'incomplete');
});

test('la selección aleatoria incluye casos evaluados con y sin flags cuando existen', async () => {
  const { state, store, c } = fixture();
  state.conversations = Array.from({ length: 10 }, (_, i) => ({ ...c, id: `c${i}`, evaluationId: `e${i}` }));
  state.evaluations = state.conversations.map((c, i) => ({ id: c.evaluationId, conversationId: c.id, createdAt: '2026-10-20', results: [{ variableId: state.catalog.find(v => v.type === 'Flag').id, status: 'evaluado', value: i === 0 ? 1 : 0 }, { variableId: 'num_mensajes_cliente', status: 'evaluado', value: 1 }] }));
  const job = await compare(store, registry((c, v) => answer(c, v), (c, v) => answer(c, v)), { max: 2, random: true });
  assert.equal(job.caseCount, 2); assert.ok(job.conversationIds.includes('c0')); assert.equal(new Set(job.conversationIds).size, 2);
});

test('dos modelos fallidos dejan el caso fallido sin una evaluación oficial falsa', async () => {
  const { state, store } = fixture();
  const fail = () => { throw new AppError(502, 'Formato inválido.', 'INVALID_AI_RESULT'); };
  const models = registry(fail, fail);
  state.settings.aiPolicy = { primaryId: 'model-0', fallbackId: 'model-1', version: 1 };
  const job = await runEvaluationBatch(store, models, { max: 1 });
  assert.equal(job.status, 'failed'); assert.equal(state.attempts.length, 4);
  assert.equal(state.evaluations.length, 0); assert.equal(state.operationalRefs.length, 0);
});

function dual(state) { state.settings.aiPolicy = { mode: 'dual', primaryId: 'model-0', secondaryId: 'model-1', fallbackId: null, version: 1 }; }
test('doble revisión: mismo contenido, una sola marca, evidencia separada y revisión humana común', async () => {
  const { state, store, c } = fixture(); dual(state); const inputs = [];
  const fn = (c,v) => { inputs.push(JSON.stringify([c,v])); return answer(c,v,1); };
  await runEvaluationBatch(store, registry(fn, fn), { max: 1 });
  assert.equal(inputs[0], inputs[1]); assert.equal(state.evaluations.length,2);
  const view = conversationView(state,c,undefined,true), v = view.variables.find(v => v.kind === 'critical');
  assert.equal(view.evaluation.dual,true); assert.equal(v.result.comparison.detections,2);
  assert.equal(v.result.comparison.agreement,'agree-positive'); assert.equal(v.result.comparison.commonEvidence,true);
  assert.equal(view.marks.filter(m => m.id === v.id).length,1);
  const originals = JSON.stringify(state.evaluations);
  recordReview(state,c.id,{variableId:v.id,evaluationId:view.evaluation.id,expectedReviewId:null,expectedVerdictId:null,action:'refutar',reason:'falso_positivo',comment:'Prueba de revisión compartida'}, {id:'u',name:'Supervisor'});
  const after = conversationView(state,c,undefined,true).variables.find(x=>x.id===v.id);
  assert.equal(after.kind,'refuted'); assert.equal(after.result.comparison.detections,2);
  assert.equal(JSON.stringify(state.evaluations),originals);
});
test('detección exclusiva de Gemini conserva discrepancia sin publicar un flag automático', async () => {
  const { state,store,c }=fixture();dual(state);
  await runEvaluationBatch(store,registry((c,v)=>answer(c,v,0),(c,v)=>answer(c,v,1)),{max:1});
  const view=conversationView(state,c,undefined,true), flag=view.variables.find(v=>v.classification==='critical');
  assert.equal(flag.kind,null);assert.equal(flag.consensusSuppressed,true);assert.equal(view.critical,0);
  assert.equal(flag.result.value,1);assert.equal(flag.result.comparison.agreement,'disagree');
  assert.equal(flag.result.comparison.cells[0].result.value,0);assert.equal(flag.result.comparison.cells[1].result.value,1);
});
test('fallo de GPT conserva resultado Gemini sin flag; reanudar completa el acuerdo sin repetir Gemini',async()=>{
  const {state,store,c}=fixture();dual(state);let fail=true,geminiCalls=0,gptCalls=0;
  const models=registry((c,v)=>{gptCalls++;if(fail)throw new AppError(502,'No disponible','AI_TRANSIENT');return answer(c,v,1);},(c,v)=>{geminiCalls++;return answer(c,v,1);});
  const job=await runEvaluationBatch(store,models,{max:1});assert.equal(job.status,'partial');assert.equal(gptCalls,2);assert.equal(geminiCalls,1);
  const view=conversationView(state,c,undefined,true),flag=view.variables.find(v=>v.classification==='critical'),id=view.evaluation.id;
  assert.equal(flag.kind,null);assert.equal(flag.consensusPending,true);assert.ok(view.consensusPendingFlags>0);
  assert.equal(flag.result.comparison.agreement,'incomplete');assert.equal(flag.result.comparison.cells[0].result,null);assert.match(flag.result.comparison.contingencyLabel,/respaldo/);assert.equal(state.evaluations[0].contingencyFor.id,'model-0');
  assert.throws(()=>recordReview(state,c.id,{variableId:flag.id,evaluationId:id,expectedReviewId:null,action:'refutar',reason:'falso_positivo',comment:'Revisión antes del reintento'}, {id:'u',name:'Supervisor'}), /flag vigente/);
  fail=false;await (await resumeEvaluationBatch(store,models,job.id)).completion;
  const after=conversationView(state,c,undefined,true);assert.equal(after.evaluation.id,id);assert.equal(after.variables.find(v=>v.id===flag.id).kind,'critical');
  assert.equal(after.variables.find(v=>v.id===flag.id).result.comparison.agreement,'agree-positive');assert.equal(geminiCalls,1);assert.equal(state.evaluations.length,2);
});
test('cero más abstención no es un negativo completo y código no suma votos',async()=>{
  const {state,store,c}=fixture();dual(state);state.catalog.find(v=>v.id==='num_mensajes_cliente').active=true;
  await runEvaluationBatch(store,registry((c,v)=>answer(c,v,0),(c,v)=>answer(c,v,null)),{max:1});
  const view=conversationView(state,c,undefined,true);
  const ai=view.variables.find(v=>v.result.comparison?.cells.length);
  assert.equal(ai.result.value,null);assert.equal(ai.result.status,'no_evaluado');assert.equal(ai.result.comparison.agreement,'incomplete');
  const code=view.variables.find(v=>v.id==='num_mensajes_cliente');assert.equal(code.result.value,1);assert.equal(code.result.comparison,undefined);
});
test('fallos no técnicos no publican el secundario como un respaldo automático y no reaparecen al adjuntar Atom',async()=>{
  const {state,store,c}=fixture();dual(state);
  await runEvaluationBatch(store,registry(()=>{throw new AppError(422,'Rechazo','AI_SAFETY_REFUSAL');},(c,v)=>answer(c,v,1)),{max:1});
  assert.equal(state.operationalRefs.length,0);
  const {ensureEvaluationState}=await import('../src/evaluation-context.js');ensureEvaluationState(state);
  assert.equal(conversationView(state,c,undefined,true).evaluated,false);
  const {AtomHistoryStore}=await import('../src/store.js');const attached=new AtomHistoryStore(store,{}).attach(state,{conversations:[c],countries:[],loadedAt:'now'});
  assert.equal(conversationView(attached,attached.conversations[0],undefined,true).evaluated,false);
});
test('refutaciones heredadas con huella siguen vigentes después de introducir los dictámenes comunes',async()=>{
  const {state,store,c}=fixture();await runEvaluationBatch(store,registry((c,v)=>answer(c,v,1),(c,v)=>answer(c,v,0)),{max:1});
  const view=conversationView(state,c,undefined,true),flag=view.variables.find(v=>v.classification==='critical');
  state.reviews.push({id:'legacy-review',conversationId:c.id,evaluationId:view.evaluation.id,variableId:flag.id,action:'refutar',authorName:'Persona',createdAt:'2026-11-03T00:00:00Z'});
  assert.equal(conversationView(state,c,undefined,true).variables.find(v=>v.id===flag.id).kind,'refuted');
});

test('formato inválido, timeout y respuesta incompleta tienen reintentos acotados y respaldo identificado', async()=>{
  for(const code of ['INVALID_AI_RESULT','AI_UNAVAILABLE','AI_INCOMPLETE']) {
    const {state,store}=fixture();let primary=0,secondary=0;
    const models=registry(()=>{primary++;throw new AppError(502,'No completada',code);},(c,v)=>{secondary++;return answer(c,v,0);});
    state.settings.aiPolicy={mode:'single',primaryId:'model-0',fallbackId:'model-1',version:1};
    const job=await runEvaluationBatch(store,models,{max:1});
    assert.equal(job.status,'completed');assert.equal(primary,2);assert.equal(secondary,1);assert.equal(state.evaluations[0].usedFallback,true);
  }
});
