import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createState } from '../src/data/seed.js';
import { dualizeEvaluation } from './fixtures/dual-state.js';

const base = '/pulsoAtom/api';
function fixture() {
  const state = createState(false);
  state.users.push({ id: 'demo-admin', name: 'QA', role: 'admin', active: true });
  state.countries = [{ code: 'HN', name: 'Honduras' }, { code: 'PA', name: 'Panamá' }];
  const template = state.catalog.find(v => v.type === 'Flag' && v.method === 'IA' && v.active);
  state.catalog = ['critical', 'normal', 'positive'].flatMap(kind => Array.from({ length: 3 }, (_, i) => ({
    ...template, id: `${kind}_${i}`, name: `${kind} ${i}`, version: 1, active: true,
    mark: kind === 'critical' ? 'Crítico' : kind === 'positive' ? '+' : '', polarity: kind === 'positive' ? 'positivo' : 'negativo',
  })));
  state.catalogVersions = state.catalog.map(snapshot => ({ id: `${snapshot.id}:1`, itemId: snapshot.id, version: 1, snapshot }));
  const add = (id, { critical = 0, normal = 0, positive = 0, status = 'evaluated', country = 'HN', time = '12:00:00', human = false, refuted = false } = {}) => {
    const at = `2026-11-12T${time}.000Z`;
    const c = { id, country, agent: { id: 'a', name: 'Asesor' }, client: { name: 'Cliente sintético' }, completed: false, sourceState: 'ABIERTO',
      date: '2026-11-12', activityDate: '2026-11-12', startedAt: at, activityAt: at, media: [], topics: [],
      messages: [{ id: `${id}-message`, actor: 'cliente', text: 'Prueba sintética.', timestamp: at }] };
    state.conversations.push(c);
    if (status === 'not_evaluated') return c;
    const counts = { critical, normal, positive };
    const evaluation = { id: `eval-${id}`, conversationId: id, createdAt: at,
      catalogVersions: state.catalog.map(v => ({ id: v.id, version: 1, active: true })),
      results: state.catalog.map(v => ({ variableId: v.id, status: 'evaluado', value: Number(Number(v.id.split('_')[1]) < counts[v.id.split('_')[0]]), evidence: [] })),
    };
    c.evaluationId = evaluation.id; state.evaluations.push(evaluation);
    const { jobId } = dualizeEvaluation(state, c, evaluation);
    const second = state.tasks.find(t => t.jobId === jobId && t.profile.id === 'synthetic-second');
    if (status === 'review_pending') second.status = 'running';
    if (status === 'partial') second.status = 'partial';
    if (human || refuted) state.reviews.push({ id: `review-${id}`, conversationId: id, evaluationId: evaluation.id, variableId: 'normal_0', action: human ? 'levantar' : 'refutar', createdAt: at });
    return c;
  };
  const store = {
    read: async () => structuredClone(state),
    transaction: async fn => { const draft = structuredClone(state); const result = await fn(draft); Object.assign(state, draft); return result; },
  };
  const app = createApp(store, { demo: true, origin: 'http://127.0.0.1:3000', sessionHours: 8, timezone: 'America/Tegucigalpa' });
  return { state, add, client: request.agent(app) };
}
async function login(client) { await client.post(`${base}/auth/demo`).send({ role: 'admin' }).expect(200); }

test('Activas orders all matching conversations before pagination, with positives and stable ties', async () => {
  const { add, client } = fixture();
  for (let i = 0; i < 15; i++) add(`filler-${i}`, { positive: 1, country: 'PA' });
  add('normal-many', { normal: 3, positive: 3 });
  add('critical-one', { critical: 1, normal: 3, positive: 3 });
  add('critical-two-low', { critical: 2 });
  add('critical-two-normal', { critical: 2, normal: 1 });
  add('critical-two-positive', { critical: 2, normal: 1, positive: 2 });
  add('tie-b', { critical: 2, normal: 1, positive: 2, time: '13:00:00' });
  add('tie-a', { critical: 2, normal: 1, positive: 2, time: '13:00:00' });
  add('hidden-new', { status: 'not_evaluated' });
  add('hidden-review', { critical: 3, status: 'review_pending' });
  add('partial', { normal: 1, status: 'partial' });
  await login(client);
  const first = (await client.get(`${base}/active?pageSize=12`).expect(200)).body;
  assert.deepEqual(first.items.slice(0, 7).map(c => c.id), ['tie-a', 'tie-b', 'critical-two-positive', 'critical-two-normal', 'critical-two-low', 'critical-one', 'normal-many']);
  assert.equal(first.total, 23); assert.equal(first.metrics.total, 23); assert.equal(first.items.length, 12);
  const second = (await client.get(`${base}/active?pageSize=12&page=2`).expect(200)).body;
  assert.equal(second.total, 23); assert.equal(second.items.length, 11);
  assert.equal(new Set([...first.items, ...second.items].map(c => c.id)).size, 23);
  assert.ok([...first.items, ...second.items].some(c => c.id === 'partial' && c.evaluationStatus === 'partial'));
  const positives = (await client.get(`${base}/active?figures=positive&countries=PA&pageSize=12`).expect(200)).body;
  assert.equal(positives.total, 15); assert.equal(positives.items.length, 12); assert.equal(positives.metrics.total, 15);
  assert.ok(positives.items.every(c => c.country === 'PA'));
  assert.equal((await client.get(`${base}/active?figures=positive&countries=PA&page=2&pageSize=12`).expect(200)).body.items.length, 3);
});

test('Activas has only three exception categories, OR selection, empty versus omitted and effective human flags', async () => {
  const { add, client } = fixture();
  add('critical', { critical: 1 }); add('normal', { normal: 1 }); add('positive', { positive: 1 });
  add('human-normal', { human: true }); add('refuted-normal', { normal: 1, refuted: true }); add('clear');
  add('hidden', { status: 'not_evaluated' }); add('waiting', { critical: 2, status: 'review_pending' });
  await login(client);
  const all = (await client.get(`${base}/active`).expect(200)).body;
  assert.equal(all.total, 6); assert.equal(all.metrics.withAlerts, 3);
  const explicitAll = (await client.get(`${base}/active?figures=positive,normal,critical`).expect(200)).body;
  assert.deepEqual(explicitAll.items.map(c => c.id), all.items.map(c => c.id));
  const normal = (await client.get(`${base}/active?figures=normal`).expect(200)).body;
  assert.deepEqual(new Set(normal.items.map(c => c.id)), new Set(['normal', 'human-normal']));
  assert.ok(normal.items.find(c => c.id === 'human-normal').marks.some(m => m.kind === 'human' && m.classification === 'normal' && m.effective));
  const either = (await client.get(`${base}/active?figures=critical,positive`).expect(200)).body;
  assert.deepEqual(new Set(either.items.map(c => c.id)), new Set(['critical', 'positive']));
  assert.equal(either.total, 2); assert.equal(either.metrics.total, 2);
  const empty = (await client.get(`${base}/active?figures=`).expect(200)).body;
  assert.equal(empty.total, 0); assert.deepEqual(empty.items, []); assert.equal(empty.metrics.total, 0);
  for (const invalid of ['human', 'refuted', 'critical,invalid']) await client.get(`${base}/active?figures=${invalid}`).expect(422);
});
