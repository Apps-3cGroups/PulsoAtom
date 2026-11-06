import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { resumeEvaluationBatch } from '../src/evaluation-service.js';
import { createGemmaBackfillPlan, executeGemmaBackfill, inspectGemmaBackfill,
  persistBackfillManifest, acquireBackfillLock } from '../src/gemma-backfill.js';

const maintenanceId = '19eea54a-282b-496c-b0c2-b3ed2c25e668';
function fixture(count = 2) {
  const state = createState(false);
  state.catalog = state.catalog.filter(v => ['cliente_molesto', 'cliente_pidio_supervisor'].includes(v.id));
  state.catalog.forEach(v => { v.active = true; });
  // Persist matching active versions, as the real catalog does before a run.
  state.catalogVersions = state.catalog.map(v => ({ itemId: v.id, version: v.version, snapshot: structuredClone(v) }));
  state.conversations = Array.from({ length: count }, (_, index) => ({ id: String(index + 1), country: 'HN',
    completed: index % 2 === 0, date: '2026-11-06', sourceDocumentId: `doc-${index + 1}`,
    messages: [{ id: `m-${index + 1}`, actor: 'cliente', text: 'TEXTO_PRIVADO_SINTETICO', timestamp: '2026-11-06T10:00:00.000Z' }] }));
  state.settings = { ...state.settings, dailyEnabled: false, evaluationMaintenance: maintenanceId,
    aiPolicy: { mode: 'single', primaryId: 'gemma-local', secondaryId: null, fallbackId: null, version: 6 } };
  const control = { partial: false, abstain: false, mutations: 0, beforeTransaction: null };
  const calls = [];
  const registry = new ModelRegistry([{ id: 'gemma-local', label: 'Gemma', provider: 'gateway', model: 'gemma-synthetic', enabled: true,
    evaluator: { configured: true, baseUrl: 'http://synthetic.invalid', timeoutMs: 1000, toolKey: 'gemma',
      async evaluate(conversation, variables) {
        calls.push({ id: conversation.id, variables: variables.map(v => v.id) });
        const invalid = variable => control.partial && (control.partialAll || conversation.id === '1') && variable.id === 'cliente_pidio_supervisor';
        return { model: 'gemma-synthetic', results: variables.filter(v => !invalid(v)).map(variable => ({
          variableId: variable.id, type: variable.type, method: variable.method,
          status: control.abstain ? 'no_evaluado' : 'evaluado', value: control.abstain ? null : 0,
          reason: control.abstain ? 'Contexto insuficiente en esta prueba sintética.' : 'El evento no aparece en esta prueba sintética.', evidence: [],
        })), validationErrors: variables.filter(invalid).map(v => ({ variableId: v.id, code: 'INVALID_AI_RESULT', rules: ['invalid_reason'] })) };
      },
    } }]);
  const store = {
    async read() { return structuredClone(state); },
    async readWithConversations() { return structuredClone(state); },
    async transaction(fn) {
      if (control.beforeTransaction) { const callback = control.beforeTransaction; control.beforeTransaction = null; callback(state); }
      const draft = structuredClone(state), value = await fn(draft);
      Object.assign(state, draft); control.mutations++; return structuredClone(value);
    },
  };
  const plan = () => createGemmaBackfillPlan(state, registry, { maintenanceId });
  return { state, registry, store, calls, control, plan };
}

test('planning includes open and closed chats, stores reproducible hashes and no transcripts, and is pure', () => {
  const { state, registry, calls, control, plan } = fixture(3);
  state.settings.evaluationMaintenance = null;
  state.conversations.push({ id: 'empty', messages: [] });
  const before = structuredClone(state), manifest = plan();
  assert.equal(manifest.conversations.length, 3);
  assert.equal(manifest.conversations.filter(c => c.completedAtSource).length, 2);
  assert.ok(manifest.conversations.every(c => c.sourceHash && c.catalogHash && c.promptHash && c.rulesVersion && c.sourceDocumentId));
  assert.doesNotMatch(JSON.stringify(manifest), /TEXTO_PRIVADO|"timestamp"|"messages"|"client"|synthetic\.invalid/);
  assert.deepEqual(state, before); assert.deepEqual(calls, []); assert.equal(control.mutations, 0);
  for (const override of [{ mode: 'dual' }, { primaryId: 'clef-local' }, { fallbackId: 'clef-local' }, { secondaryId: 'clef-local' }]) {
    const altered = structuredClone(state); Object.assign(altered.settings.aiPolicy, override);
    assert.throws(() => createGemmaBackfillPlan(altered, registry), { code: 'GEMMA_SINGLE_REQUIRED' });
  }
});

test('partial responses are never completion; explicit resume reuses tasks and preserves valid results and daily pause', async () => {
  const { state, store, registry, calls, control, plan } = fixture();
  const manifest = plan(); control.partial = true;
  const first = await executeGemmaBackfill(store, registry, manifest, { maxBatches: 1 });
  assert.equal(first.completed, 1); assert.equal(first.pending, 1); assert.equal(first.status, 'partial');
  assert.equal(first.maintenanceReleased, false); assert.equal(state.settings.evaluationMaintenance, maintenanceId);
  const task = state.tasks.find(t => t.conversationId === '1'), taskId = task.id, previousEvaluation = task.evaluationId;
  const firstCalls = calls.length;
  await assert.rejects(executeGemmaBackfill(store, registry, manifest), { code: 'BACKFILL_RESUME_REQUIRED' });
  control.partial = false;
  const result = await executeGemmaBackfill(store, registry, manifest, { resume: true });
  assert.equal(result.completed, 2); assert.equal(result.pending, 0); assert.equal(result.maintenanceReleased, true);
  assert.equal(state.jobs.length, 1); assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks.find(t => t.id === taskId).round, 2);
  assert.ok(state.evaluations.some(e => e.id === previousEvaluation));
  assert.deepEqual(calls.slice(firstCalls), [{ id: '1', variables: ['cliente_pidio_supervisor'] }]);
  assert.equal(state.settings.dailyEnabled, false); assert.equal(state.settings.evaluationMaintenance, null);
  const finalCalls = calls.length;
  assert.equal((await executeGemmaBackfill(store, registry, manifest, { resume: true })).status, 'completed');
  assert.equal(calls.length, finalCalls, 'Already completed is a read-only result, not another evaluation');
});

test('missing, partial, invalid, or non-equivalent stored evaluation cannot satisfy a completed task', async () => {
  const { state, store, registry, plan } = fixture(1), manifest = plan();
  await executeGemmaBackfill(store, registry, manifest);
  const original = structuredClone(state.evaluations[0]);
  for (const corrupt of [
    evaluation => { evaluation.partial = true; },
    evaluation => { evaluation.results[0].error = { code: 'INVALID_AI_RESULT' }; },
    evaluation => { evaluation.results[0].value = null; },
    evaluation => { evaluation.results = []; },
    evaluation => { evaluation.sourceHash = 'different'; },
    evaluation => { evaluation.model = 'clef-synthetic'; },
    evaluation => { evaluation.catalogVersions[0].version++; },
  ]) {
    state.evaluations[0] = structuredClone(original); corrupt(state.evaluations[0]);
    assert.equal(inspectGemmaBackfill(state, manifest).completed, 0);
    assert.equal(inspectGemmaBackfill(state, manifest).invalid, 1);
  }
  state.evaluations = [];
  assert.equal(inspectGemmaBackfill(state, manifest).invalid, 1);
});

test('valid context abstention counts as evaluated without requiring an invented zero', async () => {
  const { state, store, registry, control, plan } = fixture(1);
  control.abstain = true;
  const result = await executeGemmaBackfill(store, registry, plan());
  assert.equal(result.completed, 1); assert.equal(result.pending, 0);
  assert.ok(state.evaluations[0].results.every(r => r.status === 'no_evaluado' && r.value === null && !r.error));
  assert.equal(state.settings.dailyEnabled, false);
});

test('source drift remains explicitly pending with frozen original hashes and no replacement inference', async () => {
  const { state, store, registry, calls, plan } = fixture();
  const manifest = plan(), originalHash = manifest.conversations[0].sourceHash;
  state.conversations[0].messages[0].text = 'Contenido cambiado después de fijar la muestra.';
  const result = await executeGemmaBackfill(store, registry, manifest);
  assert.equal(result.changed, 1); assert.equal(result.completed, 1); assert.equal(result.pending, 1);
  assert.ok(calls.every(c => c.id === '2'));
  assert.equal(manifest.conversations[0].sourceHash, originalHash);
  assert.equal(state.settings.evaluationMaintenance, maintenanceId); assert.equal(state.settings.dailyEnabled, false);
});

test('source changing after a durable reservation cannot strand other untouched conversations', async () => {
  const { state, store, registry, calls, plan } = fixture(), manifest = plan();
  let changed = false;
  await assert.rejects(executeGemmaBackfill(store, registry, manifest, { checkpoint: async current => {
    if (!changed && current.batches.length && !current.batches[0].jobId) {
      state.conversations[0].messages[0].text = 'Cambió después de reservar y antes de iniciar.'; changed = true;
    }
  } }), { code: 'SOURCE_CHANGED' });
  assert.equal(state.jobs.length, 0); assert.equal(calls.length, 0);
  const result = await executeGemmaBackfill(store, registry, manifest, { resume: true });
  assert.equal(result.completed, 1); assert.equal(result.changed, 1);
  assert.deepEqual(state.jobs[0].conversationIds, ['2']);
  assert.equal(manifest.conversations.length, 2, 'The frozen universe retains the changed case');
});

test('scoped maintenance resume preserves changed pending tasks and completes the other partial cases', async () => {
  const { state, store, registry, calls, control, plan } = fixture(), manifest = plan();
  control.partial = true; control.partialAll = true;
  await executeGemmaBackfill(store, registry, manifest, { maxBatches: 1 });
  const jobId = state.jobs[0].id, first = state.tasks.find(t => t.conversationId === '1');
  first.status = 'pending'; state.jobs[0].status = 'interrupted';
  const firstBefore = structuredClone(first), count = calls.length;
  state.conversations[0].messages[0].text = 'La primera conversación cambió.';
  control.partial = false;
  const result = await executeGemmaBackfill(store, registry, manifest, { resume: true });
  assert.equal(result.changed, 1); assert.equal(result.completed, 1);
  assert.deepEqual(state.tasks.find(t => t.id === first.id), firstBefore);
  assert.deepEqual(calls.slice(count), [{ id: '2', variables: ['cliente_pidio_supervisor'] }]);
  assert.equal(state.jobs[0].status, 'interrupted', 'Unselected pending cases cannot leave a stopped worker marked running');
  await assert.rejects(resumeEvaluationBatch(store, registry, jobId, { conversationIds: ['outside-universe'] }), { code: 'INVALID_RECHECK' });
  state.settings.evaluationMaintenance = null;
  await assert.rejects(resumeEvaluationBatch(store, registry, jobId, { conversationIds: ['1'] }), { code: 'EVALUATION_MAINTENANCE' });
});

test('catalog, instructions, daily setting and policy changes fail closed before provider calls', async () => {
  for (const [mutate, code] of [
    [state => { state.catalog[0].version++; }, 'CATALOG_CHANGED'],
    [state => { state.settings.dailyEnabled = true; }, 'DAILY_MUST_BE_PAUSED'],
    [state => { state.settings.aiPolicy.version++; }, 'POLICY_CHANGED'],
  ]) {
    const { state, store, registry, calls, control, plan } = fixture(), manifest = plan();
    mutate(state);
    await assert.rejects(executeGemmaBackfill(store, registry, manifest), { code });
    assert.deepEqual(calls, []); assert.equal(control.mutations, 0);
  }
  const { state, store, registry, calls, control, plan } = fixture(), manifest = plan();
  control.beforeTransaction = current => { current.settings.aiPolicy.version++; };
  await assert.rejects(executeGemmaBackfill(store, registry, manifest), { code: 'POLICY_CHANGED' });
  assert.deepEqual(calls, []); assert.deepEqual(state.jobs, []);
});

test('durable prepared batch recovers its already saved job without duplicate tasks after checkpoint failure', async () => {
  const { state, store, registry, calls, plan } = fixture(1), manifest = plan();
  let persisted;
  await assert.rejects(executeGemmaBackfill(store, registry, manifest, { checkpoint: async current => {
    if (current.batches[0]?.jobId) throw new Error('Synthetic checkpoint failure');
    persisted = structuredClone(current);
  } }), /Synthetic checkpoint failure/);
  assert.equal(persisted.batches[0].jobId, null); assert.equal(state.jobs.length, 1);
  const count = calls.length;
  const result = await executeGemmaBackfill(store, registry, persisted, { resume: true });
  assert.equal(result.completed, 1); assert.equal(calls.length, count); assert.equal(state.tasks.length, 1);
  assert.equal(state.settings.dailyEnabled, false);
});

test('retry rounds are bounded and a persistent partial never clears maintenance or enables daily', async () => {
  const { state, store, registry, control, plan } = fixture(1), manifest = plan();
  control.partial = true;
  const result = await executeGemmaBackfill(store, registry, manifest);
  assert.equal(state.tasks[0].round, 3); assert.equal(state.jobs.length, 1);
  assert.equal(result.completed, 0); assert.equal(result.partial, 1); assert.equal(result.maintenanceReleased, false);
  assert.equal(state.settings.evaluationMaintenance, maintenanceId); assert.equal(state.settings.dailyEnabled, false);
  const attempts = state.attempts.length;
  await executeGemmaBackfill(store, registry, manifest, { resume: true });
  assert.equal(state.attempts.length, attempts);
});

test('one worker owns the filesystem lock; checkpoints are recoverable private files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pulso-backfill-synthetic-'));
  try {
    const filename = path.join(directory, 'manifest.json'), lock = `${filename}.lock`;
    const release = await acquireBackfillLock(lock, maintenanceId);
    await assert.rejects(acquireBackfillLock(lock, maintenanceId), { code: 'BACKFILL_LOCKED' });
    const { plan } = fixture(), manifest = plan();
    await persistBackfillManifest(filename, manifest);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), manifest);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    await release();
    const releaseAgain = await acquireBackfillLock(lock, maintenanceId); await releaseAgain();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
