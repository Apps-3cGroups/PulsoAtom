import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { fridayRun, activeReason, selectOneOffConversations, ingestionReadiness } from '../src/one-off-evaluations.js';
import { runOneOffTick } from '../src/one-off-scheduler.js';
import { listQuerySchema, filteredConversations } from '../src/domain.js';
const when = value => new Date(`2026-11-13T${value}Z`);
const chat = (id, country = 'HN') => ({ id, country, sourceDocumentId: `doc-${id}`, ingestionBatchId: country, ingestionStartedAt: '2026-11-13T16:00:00.000Z',
  sourceState: 'CERRADO', completed: true, sourceClosedAt: '2026-11-12T12:00:00.000Z', activityAt: '2026-11-12T12:00:00.000Z',
  date: '2026-11-12', startedAt: '2026-11-12T12:00:00.000Z', lastActivityAt: '2026-11-12T12:00:00.000Z',
  agent: { id: 'a', name: 'Asesor' }, client: { name: 'Cliente' }, media: [], topics: [],
  messages: [{ id: `${id}-m`, actor: 'cliente', text: 'Hola', timestamp: '2026-11-12T12:00:00.000Z' }] });
function fixture() {
 const state = createState(false), calls = [];
 state.catalog = state.catalog.filter(v => v.active && v.type === 'Flag').slice(0, 1);
 state.settings.oneOffEvaluations = [structuredClone(fridayRun)];
 state.conversations = [chat('1'), chat('2', 'PA')];
 const snapshot = { batches: [{ id: 'HN', countries: ['HN'], status: 'LISTO' }, { id: 'PA', countries: ['PA'], status: 'LISTO' }] };
 const store = { read: async () => structuredClone(state), readWithConversations: async () => structuredClone(state),
  readIngestionSnapshot: async () => snapshot, transaction: async fn => { const draft = structuredClone(state); const value = fn(draft); Object.assign(state, draft); return value; } };
 const registry = new ModelRegistry(['clef-local', 'gemma-local'].map(id => ({ id, label: id, model: id, provider: 'gateway', enabled: true,
  evaluator: { configured: true, evaluate: async (c, variables) => { calls.push([id, c.id]); return { model: id, results: variables.map(v => ({ variableId: v.id, status: 'evaluado', value: 0, reason: 'Prueba', evidence: [] })) }; } } })));
 return { state, store, registry, snapshot, calls };
}
test('Activas respects source states and Friday override without changing originals', () => {
 const settings = { oneOffEvaluations: [fridayRun] }, c = chat('1'), original = structuredClone(c);
 assert.equal(activeReason(c, settings, when('16:01:00')).code, 'friday-cohort');
 assert.equal(activeReason(c, settings, new Date(fridayRun.expiresAt)), null);
 for (const sourceState of ['ABIERTO', 'REASIGNADO', 'REINGRESO']) assert.equal(activeReason({ ...c, ingestionBatchId: null, completed: false, sourceClosedAt: null, sourceState }, settings).code, 'source-open');
 for (const sourceState of ['NUEVO', 'CERRADO', '', 'DESCONOCIDO']) assert.equal(activeReason({ ...c, ingestionBatchId: null, completed: false, sourceClosedAt: null, sourceState }, settings), null);
 assert.deepEqual(c, original);
});
test('selection caps 200 per country, stable order, includes old activity and excludes other import days', () => {
 const rows = ['HN', 'PA'].flatMap(country => Array.from({ length: 220 }, (_, i) => chat(`${country}-${i}`, country)));
 rows.push({ ...chat('old'), ingestionStartedAt: '2026-11-12T16:00:00.000Z' }, chat('mexico', 'MX'));
 const chosen = selectOneOffConversations(rows, fridayRun);
 assert.equal(chosen.length, 400); assert.equal(chosen.filter(c => c.country === 'HN').length, 200);
 assert.equal(new Set(chosen.map(c => c.id)).size, 400); assert.ok(!chosen.some(c => c.id === 'old'));
 assert.deepEqual(selectOneOffConversations([...rows].reverse(), fridayRun).map(c => c.id), chosen.map(c => c.id));
});
test('readiness requires both countries and completed batches, including unknown in-flight batches', () => {
 const { snapshot } = fixture(); assert.equal(ingestionReadiness(snapshot, fridayRun).ready, true);
 snapshot.batches.push({ id: 'later', status: 'PROCESANDO', countries: [] });
 assert.equal(ingestionReadiness(snapshot, fridayRun).ready, false);
});
test('10:29 does not start; 10:30 waits ingestion/other evaluator; expiry does not start late', async () => {
 const { state, store, registry, snapshot, calls } = fixture();
 assert.equal(await runOneOffTick(store, registry, when('16:29:00')), false);
 snapshot.batches[1].status = 'PROCESANDO';
 assert.equal(await runOneOffTick(store, registry, when('16:30:00')), true);
 assert.equal(state.settings.oneOffEvaluations[0].status, 'waiting_ingestion'); assert.equal(calls.length, 0);
 state.jobs.push({ id: 'existing', status: 'running', updatedAt: new Date().toISOString() });
 await runOneOffTick(store, registry, when('16:31:00'));
 assert.equal(state.settings.oneOffEvaluations[0].status, 'waiting_evaluation');
 state.jobs = [];
 await runOneOffTick(store, registry, new Date(fridayRun.expiresAt));
 assert.equal(state.settings.oneOffEvaluations[0].status, 'not_started'); assert.equal(calls.length, 0);
});
test('runs both models once, freezes membership, and leaves daily settings untouched', async () => {
 const { state, store, registry, calls } = fixture(); const before = state.settings.dailyTime;
 assert.equal(await runOneOffTick(store, registry, when('16:30:00')), true);
 for(let i = 0; i < 100 && state.jobs[0].status === 'running'; i++) await new Promise(r => setTimeout(r, 10));
 assert.equal(state.jobs[0].status, 'completed'); assert.equal(calls.length, 4);
 assert.equal(state.jobs[0].oneOffRun.manifest.length, 2); assert.equal(state.settings.dailyTime, before);
 state.conversations.push(chat('later'));
 await runOneOffTick(store, registry, when('17:00:00'));
 assert.equal(calls.length, 4); assert.equal(state.jobs.length, 1);
});
test('a restarted one-off job resumes pending work after midnight, never selects a new cohort', async () => {
 const { state, store, registry } = fixture();
 state.jobs.push({ id: 'interrupted', oneOffRun: { id: fridayRun.id }, status: 'interrupted' });
 let resumed = 0;
 await runOneOffTick(store, registry, new Date(fridayRun.expiresAt), { resume: async (_store, _registry, id, options) => {
  assert.equal(id, 'interrupted'); assert.equal(options.unfinishedOnly, true); resumed++; return { completion: Promise.resolve() };
 } });
 assert.equal(resumed, 1); assert.equal(state.jobs.length, 1);
});
test('country multi selection and legacy single country return the same intended chats', () => {
 const { state } = fixture(); state.conversations.push(chat('mx', 'MX'));
 assert.equal(filteredConversations(state, listQuerySchema.parse({ countries: 'HN,PA' })).length, 2);
 assert.equal(filteredConversations(state, listQuerySchema.parse({ country: 'HN' })).length, 1);
 assert.throws(() => listQuerySchema.parse({ countries: 'HN,invalid' }));
});

test('Activas API paginates across countries and excludes NEW and closed chats', async () => {
 const { default: request } = await import('supertest');
 const { createApp } = await import('../src/app.js');
 const { state, store, registry } = fixture();
 state.users.push({ id: 'demo-admin', role: 'admin', active: true, name: 'QA' });
 state.countries = [{ code: 'HN', name: 'Honduras' }, { code: 'PA', name: 'Panamá' }];
 state.conversations = Array.from({ length: 30 }, (_, i) => ({ ...chat(String(i), i % 2 ? 'PA' : 'HN'), sourceState: 'ABIERTO', completed: false, sourceClosedAt: null }));
 state.conversations.push({ ...chat('new'), sourceState: 'NUEVO', completed: false, sourceClosedAt: null }, chat('closed'));
 const client = request.agent(createApp(store, { demo: true, origin: 'http://127.0.0.1:3000', sessionHours: 8, timezone: 'America/Tegucigalpa' }, registry));
 await client.post('/pulsoAtom/api/auth/demo').send({ role: 'admin' }).expect(200);
 const first = (await client.get('/pulsoAtom/api/active?countries=HN,PA&pageSize=12').expect(200)).body;
 assert.equal(first.total, 30); assert.equal(first.items.length, 12); assert.equal(first.metrics.total, 30);
 assert.ok(first.items.every(c => c.activeReason.code === 'source-open'));
 const second = (await client.get('/pulsoAtom/api/active?countries=HN,PA&pageSize=12&page=2').expect(200)).body;
 assert.ok(second.items.every(c => !first.items.some(a => a.id === c.id)));
 assert.equal((await client.get('/pulsoAtom/api/active?country=HN').expect(200)).body.total, 15);
 const summary = (await client.get('/pulsoAtom/api/summary?countries=HN,PA').expect(200)).body;
 assert.equal(summary.metrics.total, 32);
});
