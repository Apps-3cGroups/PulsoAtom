import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { catalogReferences, evaluationContext } from '../src/evaluation-context.js';
import { resumeEvaluationBatch } from '../src/evaluation-service.js';

function fixture(newerConversationId) {
  const state = createState(false), calls = [], maintenanceId = 'scoped-supersession-test';
  const modelIds = ['clef-local', 'gemma-local'];
  state.catalog = state.catalog.filter(v => v.active && v.type === 'Flag' && v.method === 'IA').slice(0, 1);
  state.catalogVersions = state.catalogVersions.filter(v => state.catalog.some(item => item.id === v.itemId));
  state.settings.evaluationMaintenance = maintenanceId;
  state.settings.aiPolicy = { mode: 'dual', primaryId: modelIds[0], secondaryId: modelIds[1], version: 1 };
  state.conversations = ['x', 'y'].map(id => ({ id, country: 'HN', completed: false,
    date: '2026-11-10', startedAt: '2026-11-10T18:00:00Z', lastActivityAt: '2026-11-10T18:00:00Z',
    messages: [{ id: `message-${id}`, actor: 'cliente', text: 'Consulta sintética.', timestamp: '2026-11-10T18:00:00Z' }] }));
  const answer = variables => variables.map(v => ({ variableId: v.id, type: v.type, method: v.method,
    status: 'evaluado', value: 0, reason: 'Resultado sintético.', evidence: [] }));
  const registry = new ModelRegistry(modelIds.map(id => ({ id, provider: 'demo', model: id, enabled: true,
    evaluator: { configured: true, async evaluate(conversation, variables) {
      calls.push({ conversationId: conversation.id, profileId: id });
      return { model: id, results: answer(variables) };
    } } })));
  const profiles = modelIds.map(id => registry.snapshot(registry.resolve(id)));
  const original = { id: 'original', purpose: 'operational', mode: 'dual', status: 'interrupted',
    conversationIds: ['x', 'y'], modelProfiles: profiles, catalogVersions: catalogReferences(state.catalog),
    executionOrder: 'conversation-first', concurrency: 1, maintenanceId, createdAt: '2026-11-10T20:00:00Z' };
  const newer = { ...structuredClone(original), id: 'newer', status: 'completed',
    conversationIds: [newerConversationId], createdAt: '2026-11-12T20:00:00Z' };
  state.jobs = [original, newer]; state.tasks = []; state.evaluations = []; state.attempts = []; state.operationalRefs = [];
  for (const job of state.jobs) for (const id of job.conversationIds) for (const profile of profiles) {
    const context = evaluationContext(state.conversations.find(c => c.id === id), state.catalog);
    const complete = job.id === 'newer' || id === 'y';
    const task = { id: `${job.id}-${id}-${profile.id}`, jobId: job.id, conversationId: id, profile,
      fallback: null, codeResults: [], context, status: complete ? 'completed' : 'pending', round: 1,
      evaluationId: complete ? `evaluation-${job.id}-${id}-${profile.id}` : null, error: null };
    state.tasks.push(task);
    if (complete) state.evaluations.push({ id: task.evaluationId, jobId: job.id, taskId: task.id,
      conversationId: id, purpose: 'operational', profileId: profile.id, requestedProfileId: profile.id,
      provider: profile.provider, model: profile.model, modelConfiguration: profile, partial: false,
      ...context, catalogVersions: catalogReferences(state.catalog), results: answer(state.catalog), createdAt: job.createdAt });
  }
  for (const id of ['x', 'y']) {
    const evaluation = state.evaluations.filter(e => e.conversationId === id).at(-1);
    if (evaluation) state.operationalRefs.push({ id, evaluationId: evaluation.id });
  }
  const store = {
    async read() { return structuredClone(state); },
    async readWithConversations({ conversationIds } = {}) {
      return { ...structuredClone(state), conversations: structuredClone(state.conversations.filter(c => !conversationIds || conversationIds.includes(c.id))) };
    },
    async transaction(fn) { return structuredClone(fn(state)); },
  };
  return { state, store, registry, calls };
}

test('maintenance slice resumes pending x when a later job superseded only completed y', async () => {
  const f = fixture('y'), before = structuredClone(f.state);
  const execution = await resumeEvaluationBatch(f.store, f.registry, 'original', { conversationIds: ['x'] });
  await execution.completion;
  assert.deepEqual(f.calls, [{ conversationId: 'x', profileId: 'clef-local' }, { conversationId: 'x', profileId: 'gemma-local' }]);
  assert.equal(f.state.jobs.find(j => j.id === 'original').status, 'completed');
  assert.ok(f.state.tasks.filter(t => t.jobId === 'original').every(t => t.status === 'completed'));
  assert.deepEqual(f.state.tasks.map(t => t.id), before.tasks.map(t => t.id));
  assert.deepEqual(f.state.tasks.filter(t => t.conversationId === 'y'), before.tasks.filter(t => t.conversationId === 'y'));
  assert.deepEqual(f.state.evaluations.filter(e => e.conversationId === 'y'), before.evaluations.filter(e => e.conversationId === 'y'));
  assert.deepEqual(f.state.operationalRefs.find(r => r.id === 'y'), before.operationalRefs.find(r => r.id === 'y'));
  assert.deepEqual(f.state.settings, before.settings); assert.deepEqual(f.state.catalog, before.catalog);
});

test('maintenance slice rejects a later operational job and reference for selected x', async () => {
  const f = fixture('x'), before = structuredClone(f.state);
  await assert.rejects(resumeEvaluationBatch(f.store, f.registry, 'original', { conversationIds: ['x'] }), { code: 'SUPERSEDED_JOB' });
  assert.deepEqual(f.state, before); assert.deepEqual(f.calls, []);
});

test('unscoped resume still rejects supersession anywhere in the original job', async () => {
  const f = fixture('y'), before = structuredClone(f.state);
  await assert.rejects(resumeEvaluationBatch(f.store, f.registry, 'original'), { code: 'SUPERSEDED_JOB' });
  assert.deepEqual(f.state, before); assert.deepEqual(f.calls, []);
});
