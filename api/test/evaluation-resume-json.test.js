import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { runEvaluationBatch, resumeEvaluationBatch } from '../src/evaluation-service.js';
import { catalogReferences, digest } from '../src/evaluation-context.js';

test('reanudar tolera claves JSON reordenadas sin repetir modelos completados ni resultados parciales válidos', async () => {
  const state = createState(false);
  state.catalog = state.catalog.filter(v => v.active && v.type === 'Flag' && v.method === 'IA').slice(0, 2);
  assert.equal(state.catalog.length, 2);
  state.conversations = [{ id: 'synthetic-resume', country: 'HN', date: '2026-11-04', completed: true,
    messages: [{ id: 'm1', actor: 'cliente', text: 'Consulta sintética.', timestamp: '2026-11-04T15:00:00Z' }] }];
  state.settings.aiPolicy = { mode: 'dual', primaryId: 'model-0', secondaryId: 'model-1', version: 1 };
  const store = {
    async read() { return structuredClone(state); },
    async transaction(fn) {
      const draft = structuredClone(state);
      const result = await fn(draft);
      Object.assign(state, draft);
      return structuredClone(result);
    },
  };
  let fail = true;
  const calls = [[], []], missingId = state.catalog[1].id;
  const registry = new ModelRegistry([0, 1].map(i => ({
    id: `model-${i}`, provider: 'demo', model: `synthetic-${i}`, label: `Modelo sintético ${i}`, enabled: true,
    evaluator: { configured: true, async evaluate(conversation, vars) {
      calls[i].push(vars.map(v => v.id));
      return { model: `synthetic-${i}`, results: vars.filter(v => !(i === 1 && fail && v.id === missingId)).map(v => ({
        variableId: v.id, method: v.method, type: v.type, status: 'evaluado', value: 0,
        reason: 'Resultado sintético conservado.', evidence: [],
      })) };
    } },
  })));
  const first = await runEvaluationBatch(store, registry, { max: 1 });
  assert.equal(first.status, 'partial');
  const completedTask = structuredClone(state.tasks.find(t => t.profile.id === 'model-0'));
  const partialTask = state.tasks.find(t => t.profile.id === 'model-1');
  const retained = structuredClone(partialTask.profileStates['model-1'].results);
  const evaluations = structuredClone(state.evaluations);
  const fingerprints = state.tasks.map(t => structuredClone(t.context));
  assert.equal(retained.length, 1);

  // Reproduce MySQL JSON key order while preserving every semantic value.
  const job = state.jobs.find(j => j.id === first.id);
  job.catalogVersions = job.catalogVersions.map(ref => ({ id: ref.id, active: ref.active, version: ref.version }));
  assert.notEqual(digest(catalogReferences(state.catalog)), digest(job.catalogVersions));
  assert.equal(digest(catalogReferences(state.catalog)), digest(catalogReferences(job.catalogVersions)));

  // Real version changes must still block resumption before invoking models.
  const version = state.catalog[0].version;
  state.catalog[0].version++;
  await assert.rejects(resumeEvaluationBatch(store, registry, job.id), { code: 'CATALOG_CHANGED' });
  state.catalog[0].version = version;
  assert.deepEqual(calls.map(c => c.length), [1, 2]);

  fail = false;
  const resumed = await resumeEvaluationBatch(store, registry, job.id);
  assert.equal((await resumed.completion).status, 'completed');
  assert.equal(calls[0].length, 1);
  assert.deepEqual(calls[1], [[state.catalog[0].id, missingId], [missingId], [missingId]]);
  assert.deepEqual(state.tasks.find(t => t.id === completedTask.id), completedTask);
  assert.deepEqual(state.evaluations.slice(0, evaluations.length), evaluations);
  assert.deepEqual(state.tasks.map(t => t.context), fingerprints);
  const finalTask = state.tasks.find(t => t.id === partialTask.id);
  assert.equal(finalTask.status, 'completed');
  assert.deepEqual(finalTask.profileStates['model-1'].results.filter(r => r.variableId !== missingId), retained);
  assert.equal(new Set(finalTask.profileStates['model-1'].results.map(r => r.variableId)).size, 2);
});
