import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { newToken, tokenHash } from '../src/auth.js';
import { catalogReferences, digest, evaluationContext, exposeEvaluation } from '../src/evaluation-context.js';

const prefix = '/pulsoAtom/api';
const prediction = 'PREDICCION_SINTETICA_NO_REVELADA';
function fixture() {
  const state = createState(false);
  const variable = state.catalog.find(v => v.active && v.type === 'Flag' && v.method === 'IA');
  state.catalog = [variable];
  state.catalogVersions = [{ id: `${variable.id}:${variable.version}`, itemId: variable.id,
    version: variable.version, snapshot: structuredClone(variable) }];
  state.conversations = ['synthetic-1', 'synthetic-2'].map(id => ({ id, country: 'HN', date: '2026-11-06', completed: true,
    client: { name: `Cliente de prueba ${id}` }, agent: { id: 'synthetic-agent', name: 'Asesor de prueba' },
    messages: [{ id: `${id}-message`, actor: 'cliente', text: 'Texto sintético del cliente.', timestamp: '2026-11-06T15:00:00Z' }] }));
  const profiles = ['clef', 'gemma'].map(id => ({ id, label: id, provider: 'synthetic', model: `synthetic-${id}` }));
  const refs = catalogReferences(state.catalog);
  const sample = { id: 'synthetic-sample', jobId: 'synthetic-sample', name: 'Muestra de prueba',
    createdAt: new Date().toISOString(), demo: true, catalogVersions: refs, modelProfiles: profiles,
    cases: state.conversations.map(c => ({ conversationId: c.id, country: c.country, date: c.date, ...evaluationContext(c, state.catalog) })) };
  state.comparisons = [sample];
  state.jobs = [{ id: sample.id, status: 'running', updatedAt: new Date().toISOString(), total: 4, completed: 2 }];
  for (const c of sample.cases) for (const [index, profile] of profiles.entries()) {
    const id = `${c.conversationId}-${profile.id}`;
    state.tasks.push({ id, jobId: sample.id, conversationId: c.conversationId, profile, status: 'completed', evaluationId: id });
    state.evaluations.push({ id, conversationId: c.conversationId, taskId: id, purpose: 'comparison', ...c,
      profileId: profile.id, provider: profile.provider, model: profile.model,
      results: [{ variableId: variable.id, method: 'IA', status: 'evaluado', value: index ? 0 : 1, reason: prediction,
        evidence: index ? [] : [{ messageId: `${c.conversationId}-message`, quote: 'Texto sintético del cliente.' }] }] });
  }
  const tokens = Object.fromEntries(['first', 'second'].map(id => [id, newToken()]));
  state.users = Object.keys(tokens).map(id => ({ id, name: `Admin ${id}`, role: 'admin', active: true }));
  state.sessions = Object.entries(tokens).map(([id, token]) => ({ id: tokenHash(token), userId: id,
    expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  const controls = { writes: 0, freshReads: 0, beforeTransaction: null };
  const store = {
    async read() { return structuredClone(state); },
    async readWithConversations({ fresh } = {}) { assert.equal(fresh, true); controls.freshReads++; return structuredClone(state); },
    async transaction(fn) {
      await controls.beforeTransaction?.();
      const draft = structuredClone(state);
      const result = await fn(draft);
      controls.writes++; Object.assign(state, draft); return structuredClone(result);
    },
  };
  const app = createApp(store, { demo: true, basePath: '/pulsoAtom', origin: 'http://127.0.0.1:3000',
    timezone: 'America/Tegucigalpa', sessionHours: 8, secureCookie: false }, new ModelRegistry([]));
  const get = (route, user = 'first') => request(app).get(prefix + route).set('Cookie', `pulso_session=${tokens[user]}`);
  const url = `/comparisons/${sample.id}`;
  const reveal = (user = 'first', suffix = '') => get(`${url}?reveal=true${suffix}`, user);
  return { state, sample, variable, controls, get, url, reveal };
}

test('first reveal persists exposure; polling the same running sample remains read-only and keeps Atom fresh', async () => {
  const { state, sample, controls, reveal } = fixture();
  const preserved = JSON.stringify({ evaluations: state.evaluations, tasks: state.tasks, jobs: state.jobs });
  const first = await reveal().expect(200);
  assert.match(JSON.stringify(first.body.rows), new RegExp(prediction));
  assert.equal(controls.writes, 1);
  assert.deepEqual(state.exposures.map(e => e.id), sample.cases.map(c => digest(['first', c.conversationId, c.sourceHash, c.catalogHash])));
  const exposures = structuredClone(state.exposures);
  for (let i = 0; i < 3; i++) await reveal().expect(200);
  assert.equal(controls.writes, 1);
  assert.equal(controls.freshReads, 4);
  assert.deepEqual(state.exposures, exposures);
  assert.equal(JSON.stringify({ evaluations: state.evaluations, tasks: state.tasks, jobs: state.jobs }), preserved);
});

test('selected-case reveal records only that case, and expanding the sample records the remaining exposure', async () => {
  const { state, sample, controls, get, url, reveal } = fixture();
  const selected = sample.cases[0].conversationId, remaining = sample.cases[1].conversationId;
  await reveal('first', `&conversationId=${selected}`).expect(200);
  await reveal('first', `&conversationId=${selected}`).expect(200);
  assert.equal(controls.writes, 1);
  assert.deepEqual(state.exposures.map(e => e.conversationId), [selected]);
  assert.equal((await get(`${url}/validation/${selected}`).expect(200)).body.mode, 'assisted');
  assert.equal((await get(`${url}/validation/${remaining}`).expect(200)).body.mode, 'blind');
  await reveal().expect(200);
  assert.equal(controls.writes, 2);
  assert.equal(state.exposures.length, 2);
});

test('a different user, evaluated content or catalog version requires its own exact exposure', async () => {
  const { state, controls, get, url, reveal } = fixture();
  const conversationId = state.conversations[0].id;
  const suffix = `&conversationId=${conversationId}`;
  await reveal('first', suffix).expect(200);
  assert.equal((await get(`${url}/validation/${conversationId}`, 'second').expect(200)).body.mode, 'blind');
  await reveal('second', suffix).expect(200);
  assert.equal(controls.writes, 2);

  state.conversations[0].messages[0].text = 'Contenido sintético nuevo.';
  Object.assign(state.comparisons[0].cases[0], evaluationContext(state.conversations[0], state.catalog));
  assert.equal((await get(`${url}/validation/${conversationId}`).expect(200)).body.mode, 'blind');
  await reveal('first', suffix).expect(200);
  assert.equal(controls.writes, 3);

  const variable = state.catalog[0];
  variable.version++;
  state.catalogVersions.push({ id: `${variable.id}:${variable.version}`, itemId: variable.id,
    version: variable.version, snapshot: structuredClone(variable) });
  state.comparisons[0].catalogVersions = catalogReferences(state.catalog);
  Object.assign(state.comparisons[0].cases[0], evaluationContext(state.conversations[0], state.catalog));
  assert.equal((await get(`${url}/validation/${conversationId}`).expect(200)).body.mode, 'blind');
  await reveal('first', suffix).expect(200);
  assert.equal(controls.writes, 4);
  assert.equal(new Set(state.exposures.map(e => e.id)).size, 4);
  assert.equal((await get(`${url}/validation/${conversationId}`).expect(200)).body.mode, 'assisted');
});

test('a concurrent first reveal is deduplicated again inside the transaction', async () => {
  const { state, sample, controls, reveal } = fixture();
  controls.beforeTransaction = () => {
    controls.beforeTransaction = null;
    for (const c of sample.cases) exposeEvaluation(state, 'first', { ...c, catalogVersions: sample.catalogVersions });
    for (const exposure of state.exposures) exposure.createdAt = '2026-11-06T12:00:00.000Z';
  };
  await reveal().expect(200);
  assert.equal(controls.writes, 1);
  assert.equal(state.exposures.length, sample.cases.length);
  assert.ok(state.exposures.every(e => e.createdAt === '2026-11-06T12:00:00.000Z'));
  await reveal().expect(200);
  assert.equal(controls.writes, 1);
});

test('hidden comparison and blind validation contain no predictions and record no exposure', async () => {
  const { state, sample, controls, get, url } = fixture();
  const hidden = (await get(url).expect(200)).body;
  assert.deepEqual(hidden.rows, []); assert.deepEqual(hidden.metrics, []); assert.deepEqual(hidden.codeResults, []);
  assert.doesNotMatch(JSON.stringify(hidden), new RegExp(prediction));
  const blind = (await get(`${url}/validation/${sample.cases[0].conversationId}`).expect(200)).body;
  assert.equal(blind.mode, 'blind');
  assert.doesNotMatch(JSON.stringify(blind), /"(?:result|results|flags|predictions|cells|models|evidence|verdict)":/);
  assert.equal(controls.writes, 0); assert.deepEqual(state.exposures, []);
});

test('failed exposure persistence does not reveal predictions', async () => {
  const { state, controls, reveal } = fixture();
  controls.beforeTransaction = () => { throw new Error('Synthetic storage failure'); };
  const failure = await reveal().expect(500);
  assert.doesNotMatch(JSON.stringify(failure.body), new RegExp(prediction));
  assert.equal(controls.writes, 0); assert.deepEqual(state.exposures, []);
});
