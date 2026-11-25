import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { catalogV5 } from '../src/catalog-v5.js';
import { createState } from '../src/data/seed.js';
import { catalogReferences, digest, historicalProfileId } from '../src/evaluation-context.js';
import { conversationView, filteredConversations, listQuerySchema, viewContext } from '../src/domain.js';
import { enableNavigationSummaryCache } from '../src/navigation-cache.js';
import { createApp } from '../src/app.js';
import { dualizeEvaluation } from './fixtures/dual-state.js';

const FLAG = 'cliente_amenazo_cancelar_pedido';
const DESCRIPTOR = 'tipo_interaccion';
const CODE = 'primera_respuesta_humano_mayor_5_min';
function fixture() {
  const state = createState(false);
  state.catalog = catalogV5.filter(v => [FLAG, DESCRIPTOR, CODE].includes(v.id)).map(v => ({ ...structuredClone(v), active: true }));
  state.catalogVersions = state.catalog.map(v => ({ id: `${v.id}:${v.version}`, itemId: v.id, version: v.version, snapshot: v }));
  const conversation = { id: 'synthetic-completion', country: 'HN', date: '2026-11-18', activityDate: '2026-11-18',
    startedAt: '2026-11-18T15:00:00Z', activityAt: '2026-11-18T15:01:00Z', completed: true,
    client: { name: 'Cliente sintético' }, agent: { id: 'synthetic-agent', name: 'Asesor sintético' }, media: [], topics: [],
    evaluationId: 'synthetic-evaluation', messages: [{ id: 'synthetic-message', actor: 'cliente', text: 'Consulta sintética.', timestamp: '2026-11-18T15:00:00Z' }] };
  const evaluation = { id: conversation.evaluationId, conversationId: conversation.id, createdAt: '2026-11-25T12:00:00Z',
    partial: false, catalogVersions: catalogReferences(state.catalog), results: state.catalog.map(v => ({
      variableId: v.id, type: v.type, method: v.method, status: 'no_evaluado', value: null, evidence: [], reason: 'Contexto insuficiente.',
      ...(v.id === CODE ? { codeRule: 'business-hours', unavailableReason: 'BUSINESS_HOURS_NOT_CONFIGURED' } : {}),
    })) };
  state.conversations.push(conversation); state.evaluations.push(evaluation);
  const pair = dualizeEvaluation(state, conversation);
  pair.profiles.forEach((profile, index) => {
    Object.assign(profile, { id: index ? 'gemma-local' : 'clef-local', provider: 'gateway', model: index ? 'gemma-4-26b-a4b-it-mlx' : 'clef-flash' });
    profile.configurationHash = digest(profile);
    Object.assign(index ? pair.second : pair.first, { profileId: profile.id, requestedProfileId: profile.id,
      provider: profile.provider, model: profile.model, modelConfiguration: structuredClone(profile), validationErrors: [] });
  });
  return { state, conversation, ...pair, secondTask: state.tasks.find(t => t.evaluationId === pair.second.id) };
}
const check = f => conversationView(f.state, f.conversation, undefined, true);

test('both complete accepts valid abstentions without requiring detected flags or agreement', () => {
  const f = fixture(), before = structuredClone(f.state);
  for (const detail of [false, true]) {
    const view = conversationView(f.state, f.conversation, undefined, detail);
    assert.equal(view.bothModelsComplete, true);
    assert.equal(view.evaluationStatus, 'evaluated');
    assert.equal(view.dualDetected, false);
  }
  assert.equal(filteredConversations(f.state, { completion: 'both' }).length, 1);
  assert.equal(filteredConversations(f.state, { completion: 'both', agreement: 'both' }).length, 0);
  assert.equal(filteredConversations(f.state, { completion: 'both', country: 'CR' }).length, 0);
  assert.equal(filteredConversations(f.state, { completion: 'both', from: '2026-11-19' }).length, 0);
  assert.deepEqual(f.state, before);
});

test('completion excludes single, pending, partial, malformed and technically failed pairs', () => {
  const mutations = {
    single: f => { f.state.jobs[0].mode = 'single'; },
    pending: f => { f.secondTask.status = 'pending'; },
    running: f => { f.secondTask.status = 'running'; },
    failed: f => { f.secondTask.status = 'failed'; },
    partial: f => { f.second.partial = true; },
    missing: f => { f.secondTask.evaluationId = null; },
    missingDescriptor: f => { f.second.results = f.second.results.filter(r => r.variableId !== DESCRIPTOR); },
    invalidStatus: f => { f.second.results[0].status = 'unknown'; },
    duplicateResult: f => { f.second.results.push(structuredClone(f.second.results[0])); },
    resultError: f => { f.second.results.find(r => r.variableId === DESCRIPTOR).error = { code: 'INVALID_AI_RESULT' }; },
    evaluationError: f => { f.second.error = { code: 'AI_CONFIGURATION' }; },
    validationError: f => { f.second.validationErrors = [{ variableId: DESCRIPTOR, rules: ['invalid_reason'] }]; },
    taskError: f => { f.secondTask.error = { code: 'AI_INCOMPLETE' }; },
    wrongProfile: f => { f.profiles[1].id = 'other-local'; f.second.profileId = 'other-local'; },
    wrongModel: f => { f.second.model = 'another-model'; },
    demo: f => { f.second.demo = true; },
    fallback: f => { f.second.usedFallback = true; },
    inactiveItem: f => { f.second.catalogVersions.find(r => r.id === DESCRIPTOR).active = false; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const f = fixture(); mutate(f);
    assert.equal(check(f).bothModelsComplete, false, name);
    assert.equal(filteredConversations(f.state, { completion: 'both' }).length, 0, name);
    assert.equal(filteredConversations(f.state, { completion: 'all' }).length, 1, name);
  }
  const f = fixture(); f.state.evaluations = []; f.state.tasks = []; f.state.jobs = [];
  assert.equal(check(f).bothModelsComplete, false);
});

test('raw model views still report operational pair completion and preserve source-change warnings', () => {
  const f = fixture(), profile = historicalProfileId(f.first);
  assert.equal(conversationView(f.state, f.conversation, viewContext(f.state, profile), true).bothModelsComplete, true);
  f.conversation.messages[0].text += ' Actualización de fuente.';
  assert.equal(check(f).sourceChanged, true);
  assert.equal(check(f).bothModelsComplete, true);
  f.secondTask.status = 'pending';
  const raw = conversationView(f.state, f.conversation, viewContext(f.state, profile), true);
  assert.equal(raw.evaluationStatus, 'evaluated');
  assert.equal(raw.bothModelsComplete, false);
});

test('a newer incomplete operational publication cannot borrow an older complete pair', () => {
  const f = fixture();
  const current = { ...structuredClone(f.first), id: 'new-operational-anchor', jobId: 'new-job', taskId: 'new-clef-task', partial: true };
  f.state.evaluations.push(current);
  f.state.jobs.push({ ...structuredClone(f.state.jobs[0]), id: current.jobId });
  f.state.tasks.push({ id: current.taskId, jobId: current.jobId, conversationId: f.conversation.id,
    profile: f.profiles[0], status: 'partial', evaluationId: current.id },
  { id: 'new-gemma-task', jobId: current.jobId, conversationId: f.conversation.id,
    profile: f.profiles[1], status: 'pending', evaluationId: null });
  f.state.operationalRefs = [{ id: f.conversation.id, evaluationId: current.id }];
  assert.equal(check(f).evaluation.id, current.id);
  assert.equal(check(f).bothModelsComplete, false);
  assert.equal(filteredConversations(f.state, { completion: 'both' }).length, 0);
});

test('navigation projection and cache track completion changes without persisting derived fields', () => {
  const f = fixture(), cache = new Map();
  f.state.tasks.forEach(task => { delete task.codeResults; }); // Navigation omits only this field.
  const summary = () => { enableNavigationSummaryCache(f.state, cache); return filteredConversations(f.state, { completion: 'both' }); };
  assert.equal(summary().length, 1);
  assert.equal(summary()[0].bothModelsComplete, true);
  f.secondTask.status = 'running'; assert.equal(summary().length, 0);
  f.secondTask.status = 'completed'; assert.equal(summary().length, 1);
  f.second.validationErrors = [{ code: 'INVALID_AI_RESULT' }]; assert.equal(summary().length, 0);
  assert.ok(f.state.evaluations.every(e => !Object.hasOwn(e, 'bothModelsComplete')));
});

test('authenticated summary, history and detail expose completion while retaining permissions and validation', async () => {
  const f = fixture(); f.state.users = createState(true).users;
  const store = { async read() { return structuredClone(f.state); }, async transaction(fn) { return fn(f.state); } };
  const app = createApp(store, { demo: true, origin: 'http://127.0.0.1:3000', timezone: 'America/Tegucigalpa', sessionHours: 8 });
  const client = request.agent(app);
  await request(app).get('/pulsoAtom/api/summary?completion=both').expect(401);
  await client.post('/pulsoAtom/api/auth/demo').send({ role: 'supervisor' }).expect(200);
  const summary = await client.get('/pulsoAtom/api/summary?completion=both&from=2026-11-17&to=2026-11-19').expect(200);
  assert.equal(summary.body.metrics.total, 1); assert.equal(summary.body.conversations[0].bothModelsComplete, true);
  const history = await client.get('/pulsoAtom/api/conversations?completion=both&pageSize=1').expect(200);
  assert.equal(history.body.total, 1); assert.equal(history.body.items[0].bothModelsComplete, true);
  const detail = await client.get(`/pulsoAtom/api/conversations/${f.conversation.id}?completion=both`).expect(200);
  assert.equal(detail.body.conversation.bothModelsComplete, true);
  await client.get('/pulsoAtom/api/summary?completion=both&modelProfileId=clef-local').expect(403);
  await client.get('/pulsoAtom/api/summary?completion=invalid').expect(422);
  assert.equal(listQuerySchema.parse({ completion: 'all' }).completion, 'all');
  f.secondTask.status = 'running';
  assert.equal((await client.get('/pulsoAtom/api/summary?completion=both').expect(200)).body.metrics.total, 0);
  assert.equal((await client.get('/pulsoAtom/api/conversations?completion=all').expect(200)).body.total, 1);
});
