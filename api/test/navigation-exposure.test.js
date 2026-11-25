import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createState } from '../src/data/seed.js';
import { createApp } from '../src/app.js';
import { ModelRegistry } from '../src/model-registry.js';
import { newToken, tokenHash } from '../src/auth.js';
import { catalogReferences, evaluationSelectionContext, selectedStoredEvaluation, selectedEvaluation,
  evaluationExposures, exposeEvaluations, historicalProfileId, sourceFingerprint } from '../src/evaluation-context.js';
import { dualizeEvaluation } from './fixtures/dual-state.js';

const createdAt = '2026-11-25T18:00:00.000Z';
function fixture() {
  const state = createState(false);
  const variable = state.catalog.find(v => v.active && v.type === 'Flag' && v.method === 'IA');
  state.catalog = [variable];
  state.catalogVersions = [{ id: `${variable.id}:${variable.version}`, itemId: variable.id, version: variable.version, snapshot: structuredClone(variable) }];
  const conversation = { id: 'synthetic-exposure', country: 'HN', date: '2026-11-18', activityDate: '2026-11-18',
    startedAt: '2026-11-18T15:00:00Z', activityAt: '2026-11-18T15:00:00Z', completed: true,
    agent: { id: 'synthetic-agent', name: 'Synthetic agent' }, client: { name: 'Synthetic client' }, media: [], topics: [],
    evaluationId: 'synthetic-anchor', messages: [{ id: 'synthetic-message', actor: 'cliente', text: 'Synthetic inquiry.', timestamp: '2026-11-18T15:00:00Z' }] };
  state.conversations = [conversation];
  state.evaluations = [{ id: conversation.evaluationId, conversationId: conversation.id, createdAt,
    catalogVersions: catalogReferences(state.catalog), results: [{ variableId: variable.id, type: 'Flag', method: 'IA',
      status: 'evaluado', value: 1, reason: 'SYNTHETIC_PREDICTION', evidence: [] }] }];
  const pair = dualizeEvaluation(state, conversation);
  const token = newToken();
  state.users = [{ id: 'synthetic-user', name: 'Synthetic user', role: 'admin', active: true }];
  state.sessions = [{ id: tokenHash(token), userId: state.users[0].id, expiresAt: new Date(Date.now() + 60000).toISOString() }];
  return { state, conversation, token, ...pair };
}
const snapshotExposures = evaluations => evaluationExposures('synthetic-user', evaluations, { createdAt });

test('stored anchor exposure matches projected metadata for complete, partial, changed-source and raw-model views', () => {
  for (const mode of ['dual', 'partial', 'changed-source', 'raw']) {
    const f = fixture();
    if (mode === 'partial') f.state.tasks.find(t => t.evaluationId === f.second.id).status = 'pending';
    if (mode === 'changed-source') f.conversation.messages[0].text += ' Later change.';
    const profileId = mode === 'raw' ? historicalProfileId(f.second) : undefined;
    const selection = evaluationSelectionContext(f.state), before = structuredClone(f.state);
    const stored = selectedStoredEvaluation(f.state, f.conversation, profileId, selection);
    const projected = selectedEvaluation(f.state, f.conversation, profileId, selection);
    assert.deepEqual(snapshotExposures([stored]), snapshotExposures([projected]), mode);
    assert.equal(stored.id, mode === 'raw' ? f.second.id : f.first.id, mode);
    assert.deepEqual(f.state, before);
  }
});

test('stored selection retains explicit-reference precedence and latest matching profile without reading model jobs', () => {
  const f = fixture();
  const newer = { ...structuredClone(f.second), id: 'synthetic-newer', createdAt: '2026-11-26T00:00:00Z' };
  const foreign = { ...structuredClone(newer), id: 'synthetic-foreign', createdAt: '2026-11-27T00:00:00Z',
    modelConfiguration: { ...newer.modelConfiguration, configurationHash: 'different-configuration' } };
  f.state.evaluations.push(newer, foreign);
  f.conversation.evaluationId = newer.id;
  f.state.operationalRefs = [{ id: f.conversation.id, evaluationId: f.first.id }];
  const selection = evaluationSelectionContext(f.state);
  Object.defineProperty(f.state, 'jobs', { get() { throw new Error('Exposure must not rebuild model consensus'); } });
  assert.equal(selectedStoredEvaluation(f.state, f.conversation, undefined, selection), f.first);
  assert.equal(selectedStoredEvaluation(f.state, f.conversation, historicalProfileId(f.second), selection), newer);
  f.state.operationalRefs = [];
  assert.equal(selectedStoredEvaluation(f.state, f.conversation), newer);
});

test('batch exposure is pure and deduplicated, then preserves existing records with one state initialization', () => {
  const f = fixture(), evaluation = f.first;
  const evaluations = Array.from({ length: 3000 }, (_, i) => ({ ...evaluation, conversationId: `synthetic-${i}` }));
  const before = structuredClone(evaluations);
  const entries = snapshotExposures([...evaluations, ...evaluations, null, { sourceHash: null }]);
  assert.equal(entries.length, evaluations.length);
  assert.deepEqual(evaluations, before);
  const existing = { ...entries[0], createdAt: '2026-11-01T00:00:00Z' };
  const target = { exposures: [existing], operationalRefs: [] }; let evaluationReads = 0;
  Object.defineProperty(target, 'evaluations', { get() { evaluationReads++; return []; } });
  exposeEvaluations(target, 'synthetic-user', [...evaluations, evaluations[0]]);
  assert.equal(evaluationReads, 1);
  assert.equal(target.exposures.length, entries.length);
  assert.equal(target.exposures[0], existing);
  const saved = structuredClone(target.exposures);
  exposeEvaluations(target, 'synthetic-user', evaluations);
  assert.deepEqual(target.exposures, saved);
  assert.notEqual(evaluationExposures('another-user', [evaluation])[0].id, snapshotExposures([evaluation])[0].id);
  for (const key of ['sourceHash', 'catalogHash']) assert.notEqual(snapshotExposures([{ ...evaluation, [key]: 'different' }])[0].id, snapshotExposures([evaluation])[0].id);
});

function appFixture(f, recordExposures) {
  const store = { read: async () => structuredClone(f.state), readForNavigation: async () => structuredClone(f.state), recordExposures };
  const app = createApp(store, { demo: true, basePath: '/pulsoAtom', origin: 'http://127.0.0.1:3000',
    timezone: 'America/Tegucigalpa', sessionHours: 8, secureCookie: false }, new ModelRegistry([]));
  return () => request(app).get('/pulsoAtom/api/summary').set('Cookie', `pulso_session=${f.token}`);
}

test('summary waits for mandatory exposure persistence before sending predictions', async () => {
  const f = fixture(); let release, entered, returned = false, exposures;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const get = appFixture(f, async records => { exposures = records; entered(); await gate; });
  const response = get().then(value => { returned = true; return value; });
  try {
    await started;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, false);
    assert.deepEqual(exposures.map(({ createdAt: ignored, ...entry }) => entry), snapshotExposures([f.first]).map(({ createdAt: ignored, ...entry }) => entry));
  } finally { release(); }
  assert.equal((await response).status, 200);
});

test('failed exposure persistence prevents summary disclosure', async () => {
  const get = appFixture(fixture(), async () => { throw new Error('Synthetic persistence failure'); });
  const response = await get();
  assert.equal(response.status, 500);
  assert.equal(response.body.conversations, undefined);
  assert.doesNotMatch(JSON.stringify(response.body), /SYNTHETIC_PREDICTION/);
});

test('legacy missing-source exposure retains projected active variables instead of using unshown anchor results', async () => {
  const f = fixture();
  delete f.first.sourceHash; delete f.second.sourceHash;
  const projected = selectedEvaluation(f.state, f.conversation);
  assert.equal(projected.results.length, 0);
  assert.equal(f.first.results.length, 1);
  const expected = { ...projected, sourceHash: sourceFingerprint(f.conversation),
    catalogVersions: projected.catalogVersions.map(v => ({ ...v, active: projected.results.some(r => r.variableId === v.id) })) };
  let saved;
  const response = await appFixture(f, async records => { saved = records; })();
  assert.equal(response.status, 200);
  assert.deepEqual(saved.map(({ createdAt: ignored, ...entry }) => entry), snapshotExposures([expected]).map(({ createdAt: ignored, ...entry }) => entry));
  assert.ok(saved[0].catalogVersions.every(v => !v.active));
});
