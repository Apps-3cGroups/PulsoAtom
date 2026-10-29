import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { DemoStore } from '../src/store.js';
import { registryFromEnv } from '../src/model-registry.js';
import { runEvaluationBatch } from '../src/evaluation-service.js';
import { sourceFingerprint } from '../src/evaluation-context.js';

const config = { demo: true, origin: 'http://127.0.0.1:3000', sessionHours: 8, secureCookie: false, timezone: 'America/Tegucigalpa' };
let directory, store, app, admin, supervisor, sampleId, caseIds, calls = 0;
const models = registryFromEnv({ demo: true });
for (const p of models.profiles) { const evaluate = p.evaluator.evaluate; p.evaluator.evaluate = (...args) => { calls++; return evaluate(...args); }; }
const write = (agent, method, url, body) => agent[method](`/pulso/api${url}`).set('Origin', config.origin).send(body);
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'pulso-model-routes-'));
  store = await new DemoStore(path.join(directory, 'state.json')).init();
  const state = await store.read(); caseIds = state.conversations.slice(0, 2).map(c => c.id);
  const job = await runEvaluationBatch(store, models, { purpose: 'comparison', modelIds: ['demo-gpt', 'demo-gemini'], conversationIds: caseIds, max: 2 });
  sampleId = job.id;
  app = createApp(store, config, models); admin = request.agent(app); supervisor = request.agent(app);
  await write(admin, 'post', '/auth/demo', { role: 'admin' }).expect(200);
  await write(supervisor, 'post', '/auth/demo', { role: 'supervisor' }).expect(200);
});
after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });

test('permisos y política versionada: solo administrador configura y ejecuta', async () => {
  await request(app).get('/pulso/api/models').expect(401);
  const profiles = (await supervisor.get('/pulso/api/models').expect(200)).body;
  assert.equal(profiles.profiles.filter(p => p.available).length, 3);
  assert.doesNotMatch(JSON.stringify(profiles), /apiKey|Authorization|baseUrl|password/);
  const policy = { primaryId: 'demo-gpt', fallbackId: 'demo-gemini', expectedVersion: 1 };
  await write(supervisor, 'patch', '/models/policy', policy).expect(403);
  await write(supervisor, 'post', '/comparisons', {}).expect(403);
  await write(supervisor, 'post', `/evaluations/${sampleId}/resume`, {}).expect(403);
  await write(admin, 'patch', '/models/policy', { ...policy, fallbackId: 'demo-gpt' }).expect(422);
  await write(admin, 'patch', '/models/policy', policy).expect(200);
  await write(admin, 'patch', '/models/policy', policy).expect(409);
  assert.deepEqual((await store.read()).modelPolicies.map(p => p.version), [1, 2]);
});

test('la API de validación y el listado previo a revelar no filtran predicciones', async () => {
  const sample = (await supervisor.get(`/pulso/api/comparisons/${sampleId}`).expect(200)).body;
  assert.deepEqual(sample.rows, []); assert.deepEqual(sample.metrics, []); assert.deepEqual(sample.codeResults, []);
  const candidates = (await supervisor.get('/pulso/api/comparison-candidates').expect(200)).body;
  assert.deepEqual(Object.keys(candidates.items[0]).sort(), ['clientName', 'country', 'date', 'id']);
  const blind = (await supervisor.get(`/pulso/api/comparisons/${sampleId}/validation/${caseIds[0]}`).expect(200)).body;
  assert.equal(blind.mode, 'blind');
  assert.doesNotMatch(JSON.stringify(blind), /"(?:result|results|flags|predictions|cells|models|evidence|verdict)":/);
  await supervisor.get(`/pulso/api/comparisons/${sampleId}?reveal=true&conversationId=${caseIds[1]}`).expect(200);
  assert.equal((await supervisor.get(`/pulso/api/comparisons/${sampleId}/validation/${caseIds[0]}`)).body.mode, 'blind');
  assert.equal((await supervisor.get(`/pulso/api/comparisons/${sampleId}/validation/${caseIds[1]}`)).body.mode, 'assisted');
});

test('consulta por modelo no ejecuta IA ni cambia la referencia operativa', async () => {
  const before = await store.read(), count = calls;
  const profile = models.list()[0];
  await admin.get(`/pulso/api/summary?modelProfileId=${encodeURIComponent(profile.viewId)}`).expect(200);
  const original = (await admin.get(`/pulso/api/conversations/${caseIds[0]}?modelProfileId=${encodeURIComponent(profile.viewId)}`).expect(200)).body.conversation;
  assert.equal(original.rawModelView, true); assert.deepEqual(original.reviews, []);
  const after = await store.read(); assert.equal(calls, count);
  assert.deepEqual(after.evaluations, before.evaluations); assert.deepEqual(after.operationalRefs, before.operationalRefs);
});

test('dictamen completo se guarda sin alterar IA y rechaza sobrescrituras obsoletas', async () => {
  const url = `/comparisons/${sampleId}/validation/${caseIds[0]}`;
  const view = (await supervisor.get(`/pulso/api${url}`).expect(200)).body;
  const before = JSON.stringify((await store.read()).evaluations);
  const items = view.variables.map(v => ({ variableId: v.id, expectedVerdictId: view.expectedVerdicts[v.id], outcome: 'absent', comment: 'Revisión sintética sin este evento.' }));
  await write(supervisor, 'post', url, { items: items.slice(1) }).expect(422);
  assert.equal((await write(supervisor, 'post', url, { items }).expect(201)).body.validation.mode, 'blind');
  await write(supervisor, 'post', url, { items }).expect(409);
  assert.equal(JSON.stringify((await store.read()).evaluations), before);
  const state = await store.read(); const c = state.conversations.find(c => c.id === caseIds[0]);
  assert.ok(state.verdicts.every(v => v.sourceHash === sourceFingerprint(c)));
});

test('validaciones de muestras evitan ejecuciones fuera de límites y muestras vacías', async () => {
  const base = { name: 'Prueba de límites', modelIds: ['demo-gpt', 'demo-gemini'], max: 2, idempotencyKey: randomUUID() };
  await write(admin, 'post', '/comparisons', { ...base, max: 21 }).expect(422);
  await write(admin, 'post', '/comparisons', { ...base, modelIds: ['demo-gpt', 'demo-gpt'] }).expect(422);
  await write(admin, 'post', '/comparisons', { ...base, from: '2026-02-30' }).expect(422);
  const empty = await write(admin, 'post', '/comparisons', { ...base, country: 'ZZ' }).expect(422);
  assert.equal(empty.body.error.code, 'EMPTY_SAMPLE');
});

test('un reinicio deja visible la reanudación explícita de trabajos vencidos', async () => {
  await store.transaction(state => {
    state.jobs.push({ id: 'interrupted-job', status: 'running', createdAt: '2020-01-01T00:00:00Z' });
    state.tasks.push({ id: 'interrupted-task', jobId: 'interrupted-job', status: 'running' });
    state.attempts.push({ id: 'interrupted-attempt', jobId: 'interrupted-job', status: 'running' });
  });
  const jobs = (await admin.get('/pulso/api/evaluations').expect(200)).body.jobs;
  assert.equal(jobs.find(j => j.id === 'interrupted-job').status, 'interrupted');
  assert.equal((await store.read()).attempts.find(a => a.id === 'interrupted-attempt').status, 'interrupted');
});
