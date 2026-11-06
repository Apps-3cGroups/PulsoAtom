import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { runEvaluationBatch, resumeEvaluationBatch } from '../src/evaluation-service.js';

function fixture({ beforeRead, afterEvaluation, fail } = {}) {
  const state = createState(false);
  state.catalog = state.catalog.filter(v => v.active && v.type === 'Flag' && v.method === 'IA').slice(0, 1);
  const conversations = ['first', 'second'].map(id => ({ id, country: 'HN', date: '2026-11-06', completed: true,
    messages: [{ id: `${id}-message`, actor: 'cliente', text: 'Consulta sintética.', timestamp: '2026-11-06T12:00:00Z' }] }));
  state.settings.aiPolicy = { mode: 'single', primaryId: 'synthetic-model', fallbackId: null, version: 1 };
  const reads = [], calls = [];
  const store = {
    async read() { return structuredClone(state); },
    async readWithConversations(options) {
      reads.push(structuredClone(options));
      beforeRead?.({ reads, conversations });
      return { ...structuredClone(state), conversations: structuredClone(conversations.filter(c => !options.conversationIds || options.conversationIds.includes(c.id))) };
    },
    async transaction(fn) { const draft = structuredClone(state); const result = await fn(draft); Object.assign(state, draft); return structuredClone(result); },
  };
  const registry = new ModelRegistry([{ id: 'synthetic-model', provider: 'demo', model: 'synthetic-model', label: 'Sintético', enabled: true,
    evaluator: { configured: true, async evaluate(conversation, variables) {
      calls.push(conversation.id);
      if (fail?.()) throw new Error('Synthetic evaluator interruption');
      afterEvaluation?.({ conversations });
      return { model: 'synthetic-model', results: variables.map(v => ({ variableId: v.id, type: v.type, method: v.method,
        status: 'evaluado', value: 0, reason: 'Resultado sintético.', evidence: [] })) };
    } },
  }]);
  return { state, store, registry, reads, calls, conversations };
}

test('lote explícito consulta solo sus IDs al preparar, antes y después de inferencia', async () => {
  const f = fixture();
  const result = await runEvaluationBatch(f.store, f.registry, { conversationIds: ['second'], max: 1 });
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.calls, ['second']);
  assert.deepEqual(f.reads, Array.from({ length: 3 }, () => ({ fresh: true, conversationIds: ['second'] })));
  assert.equal(f.state.evaluations[0].conversationId, 'second');
  assert.deepEqual(f.state.conversations, []);
});

test('la selección sin IDs puede leer el universo, pero cada tarea relee únicamente su conversación', async () => {
  const f = fixture();
  await runEvaluationBatch(f.store, f.registry, { max: 2 });
  assert.deepEqual(f.reads[0], { fresh: true });
  assert.deepEqual(f.reads.slice(1).map(r => r.conversationIds), [['first'], ['first'], ['second'], ['second']]);
});

for (const mutation of ['missing-before', 'changed-after']) {
  test(`la lectura acotada conserva la protección de origen: ${mutation}`, async () => {
    const f = fixture({
      beforeRead: ({ reads, conversations }) => { if (mutation === 'missing-before' && reads.length === 2) conversations.splice(1, 1); },
      afterEvaluation: ({ conversations }) => { if (mutation === 'changed-after') conversations[1].messages[0].text = 'Contenido modificado.'; },
    });
    const job = await runEvaluationBatch(f.store, f.registry, { conversationIds: ['second'], max: 1 });
    assert.equal(job.status, 'failed');
    assert.equal(job.errors[0].code, 'SOURCE_CHANGED');
    assert.equal(f.state.evaluations.length, 0);
    assert.equal(f.calls.length, mutation === 'missing-before' ? 0 : 1);
    assert.ok(f.reads.every(r => r.conversationIds?.join(',') === 'second'));
  });
}

test('reanudar carga IDs del lote guardado y no vuelve a leer el universo Atom', async () => {
  let failing = true;
  const f = fixture({ fail: () => failing });
  const first = await runEvaluationBatch(f.store, f.registry, { conversationIds: ['second'], max: 1 });
  assert.equal(first.status, 'failed');
  const initialReads = f.reads.length;
  failing = false;
  const resumed = await resumeEvaluationBatch(f.store, f.registry, first.id);
  assert.equal((await resumed.completion).status, 'completed');
  assert.deepEqual(f.reads.slice(initialReads), Array.from({ length: 3 }, () => ({ fresh: true, conversationIds: ['second'] })));
  assert.deepEqual(f.calls, ['second', 'second']);
});
