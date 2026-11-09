import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { OpenAIEvaluator } from '../src/evaluator.js';
import { GeminiEvaluator } from '../src/gemini-evaluator.js';
import { ModelRegistry } from '../src/model-registry.js';
import { runEvaluationBatch, resumeEvaluationBatch } from '../src/evaluation-service.js';
import { conversationView } from '../src/domain.js';

test('Gemini parcial conserva el consenso válido y al reanudar completa solo el pendiente sin duplicar votos', async () => {
  const ids = ['cliente_molesto', 'cliente_pidio_supervisor'];
  const state = createState(false);
  state.catalog = ids.map(id => state.catalog.find(v => v.id === id));
  assert.ok(state.catalog.every(v => v.active && v.type === 'Flag' && v.method === 'IA'));
  const conversation = {
    id: 'synthetic-consolidated-dual', country: 'HN', date: '2026-11-06', completed: true,
    client: { name: 'Cliente sintético' }, agent: { id: 'synthetic-agent', name: 'Asesor sintético' },
    topics: [], media: [], messages: [
      { id: 'm1', actor: 'cliente', text: 'Estoy muy molesto por la atención.', timestamp: '2026-11-06T15:00:00Z' },
      { id: 'm2', actor: 'cliente', text: 'Quiero hablar con el supervisor.', timestamp: '2026-11-06T15:01:00Z' },
    ],
  };
  state.conversations = [conversation];
  state.settings.aiPolicy = { mode: 'dual', primaryId: 'synthetic-gpt', secondaryId: 'synthetic-gemini', version: 1 };
  const store = {
    async read() { return structuredClone(state); },
    async readWithConversations() { return structuredClone(state); },
    async transaction(fn) {
      const draft = structuredClone(state);
      const result = await fn(draft);
      Object.assign(state, draft);
      return structuredClone(result);
    },
  };
  let invalidGeminiEvidence = true;
  const calls = { openai: [], gemini: [] };
  const rawResult = id => ({ status: 'evaluado', value: 1, reason: 'Evento sintético explícito.',
    evidence_message_ids: [id === ids[0] ? 'm1' : 'm2'] });
  // Exercise both real adapters with injected transports. All data and answers
  // are synthetic: no network, credentials, or database connection is used.
  const openai = new OpenAIEvaluator({ apiKey: 'synthetic', baseUrl: 'https://openai.example.test', model: 'synthetic-gpt-model',
    fetchImpl: async (_url, options) => {
      const input = JSON.parse(JSON.parse(options.body).input);
      calls.openai.push(input);
      const raw = { results: Object.fromEntries(input.variables.map(v => [v.id, rawResult(v.id)])) };
      return { ok: true, json: async () => ({ status: 'completed', model: 'synthetic-gpt-model',
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(raw) }] }] }) };
    },
  });
  const gemini = new GeminiEvaluator({ apiKey: 'synthetic', baseUrl: 'https://gemini.example.test', model: 'synthetic-gemini-model',
    fetchImpl: async (_url, options) => {
      const input = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
      calls.gemini.push(input);
      const raw = { results: input.variables.map(v => ({ variableId: v.id, ...rawResult(v.id),
        ...(invalidGeminiEvidence && v.id === ids[1] ? { evidence_message_ids: ['unknown-message'] } : {}),
      })) };
      return { ok: true, json: async () => ({ modelVersion: 'synthetic-gemini-model',
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(raw) }] } }] }) };
    },
  });
  const registry = new ModelRegistry([
    { id: 'synthetic-gpt', provider: 'openai', model: openai.model, label: 'GPT sintético', enabled: true, evaluator: openai },
    { id: 'synthetic-gemini', provider: 'gemini', model: gemini.model, label: 'Gemini sintético', enabled: true, evaluator: gemini },
  ]);

  const job = await runEvaluationBatch(store, registry, { max: 1 });
  assert.equal(job.status, 'partial');
  assert.deepEqual(calls.openai[0], calls.gemini[0], 'Ambos modelos reciben el mismo contenido y checklist');
  assert.deepEqual(calls.gemini.map(input => input.variables.map(v => v.id)), [ids, [ids[1]]]);
  const beforeView = conversationView(state, conversation, undefined, true);
  const agreed = beforeView.variables.find(v => v.id === ids[0]);
  const pending = beforeView.variables.find(v => v.id === ids[1]);
  assert.equal(agreed.automaticFlagVisible, true);
  assert.equal(agreed.result.comparison.votes, 2);
  assert.equal(pending.automaticFlagVisible, false);
  assert.equal(pending.consensusPending, true);
  assert.equal(pending.result.comparison.votes, 1);
  assert.equal(pending.result.comparison.agreement, 'incomplete');
  assert.equal(pending.result.comparison.cells[1].error.code, 'INVALID_AI_RESULT');

  const originalEvaluations = structuredClone(state.evaluations);
  const originalGptTask = structuredClone(state.tasks.find(t => t.profile.id === 'synthetic-gpt'));
  const geminiTask = state.tasks.find(t => t.profile.id === 'synthetic-gemini');
  const retained = structuredClone(geminiTask.profileStates['synthetic-gemini'].results);
  assert.deepEqual(retained.map(r => r.variableId), [ids[0]]);
  // Match MySQL's harmless JSON key reordering while retaining context hashes.
  const savedJob = state.jobs.find(j => j.id === job.id);
  savedJob.catalogVersions = savedJob.catalogVersions.map(ref => ({ id: ref.id, active: ref.active, version: ref.version }));
  invalidGeminiEvidence = false;
  const resumed = await resumeEvaluationBatch(store, registry, job.id);
  assert.equal((await resumed.completion).status, 'completed');

  assert.equal(calls.openai.length, 1, 'GPT ya completado no se vuelve a ejecutar');
  assert.deepEqual(calls.gemini.map(input => input.variables.map(v => v.id)), [ids, [ids[1]], [ids[1]]]);
  assert.deepEqual(state.tasks.find(t => t.id === originalGptTask.id), originalGptTask);
  assert.deepEqual(state.evaluations.slice(0, originalEvaluations.length), originalEvaluations);
  assert.equal(state.evaluations.length, 3, 'La respuesta parcial permanece en el histórico');
  const completedGeminiTask = state.tasks.find(t => t.id === geminiTask.id);
  assert.equal(completedGeminiTask.round, 2);
  assert.deepEqual(completedGeminiTask.profileStates['synthetic-gemini'].results.filter(r => r.variableId === ids[0]), retained);
  const currentPair = state.tasks.map(t => state.evaluations.find(e => e.id === t.evaluationId));
  for (const key of ['sourceHash', 'catalogHash', 'promptHash', 'rulesVersion']) {
    assert.ok(currentPair[0][key]);
    assert.equal(currentPair[0][key], currentPair[1][key]);
  }
  const finalView = conversationView(state, conversation, undefined, true);
  assert.equal(finalView.evaluation.modelReviewPending, false);
  assert.equal(finalView.marks.length, 2);
  for (const flag of finalView.variables) {
    assert.equal(flag.automaticFlagVisible, true);
    assert.equal(flag.dualDetected, true);
    assert.equal(flag.result.comparison.agreement, 'agree-positive');
    assert.equal(flag.result.comparison.detections, 2);
    assert.equal(flag.result.comparison.votes, 2, 'La evaluación parcial anterior no suma otro voto');
    assert.equal(flag.result.comparison.cells.length, 2);
    assert.equal(new Set(flag.result.comparison.cells.map(cell => `${cell.provider}:${cell.model}`)).size, 2);
  }
  await assert.rejects(resumeEvaluationBatch(store, registry, job.id), { code: 'ALREADY_COMPLETED' });
  assert.equal(calls.openai.length, 1);
  assert.equal(calls.gemini.length, 3);
});
