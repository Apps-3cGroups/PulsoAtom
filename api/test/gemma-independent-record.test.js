import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { registryFromEnv } from '../src/model-registry.js';
import { runEvaluationBatch, resumeEvaluationBatch } from '../src/evaluation-service.js';
import { conversationView } from '../src/domain.js';
import { evaluationContext } from '../src/evaluation-context.js';

const FLAG = 'cliente_amenazo_cancelar_pedido';
const GEMMA_MODEL = 'gemma-independent-synthetic';
const CLEF_MODEL = 'clef-independent-synthetic';
const GEMMA_REASON = 'Gemma: el cliente amenaza explícitamente con cancelar en este ejemplo sintético.';

function fixture(mode) {
  const initial = createState(false);
  initial.catalog = initial.catalog.filter(variable => variable.id === FLAG);
  initial.catalog.forEach(variable => { variable.active = true; });
  initial.catalogVersions = initial.catalog.map(variable => ({ id: `${variable.id}:${variable.version}`,
    itemId: variable.id, version: variable.version, snapshot: structuredClone(variable) }));
  const conversation = { id: 'synthetic-independent-gemma', country: 'HN', completed: true, date: '2026-11-06',
    messages: [{ id: 'synthetic-client-message', actor: 'cliente', text: 'Si el pedido no llega hoy, voy a cancelarlo.',
      timestamp: '2026-11-06T15:00:00.000Z' }] };
  initial.conversations = [conversation];
  initial.settings = { ...initial.settings, dailyEnabled: false,
    aiPolicy: { mode, primaryId: mode === 'single' ? 'gemma-local' : 'clef-local',
      secondaryId: mode === 'single' ? null : 'gemma-local', fallbackId: null, version: 1 } };
  // Every read crosses a JSON serialization boundary, matching the persisted
  // payload contract without requiring a real database or retaining live objects.
  let persisted = JSON.stringify(initial);
  const store = {
    async read() { return JSON.parse(persisted); },
    async readWithConversations() { return JSON.parse(persisted); },
    async transaction(fn) {
      const draft = JSON.parse(persisted), result = await fn(draft);
      persisted = JSON.stringify(draft);
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    },
  };
  const calls = [], control = { clefAvailable: false };
  const env = { GATEWAY_BASE_URL: 'http://gateway.synthetic:9000', GATEWAY_PORTAL_KEY: 'pulso-test',
    AGENT_SHARED_TOKEN: 'synthetic-token-never-persisted', GEMMA_TOOL_KEY: 'gemma',
    GEMMA_MODEL, GEMMA_EVALUATION_ENABLED: 'true',
    ...(mode === 'dual' ? { CLEF_TOOL_KEY: 'clef', CLEF_MODEL, CLEF_EVALUATION_ENABLED: 'true' } : {}) };
  const registry = registryFromEnv({ env, fetchImpl: async (url, options) => {
    assert.equal(new URL(url).origin, env.GATEWAY_BASE_URL);
    const tool = new URL(url).pathname.split('/')[3];
    const envelope = JSON.parse(options.body);
    assert.equal(envelope.path, '/v1/chat/completions');
    const input = JSON.parse(envelope.body.messages.at(-1).content);
    calls.push({ tool, model: envelope.body.model, variableIds: input.variables.map(variable => variable.id) });
    if (tool === 'clef' && !control.clefAvailable) return { ok: false, status: 503 };
    const results = Object.fromEntries(input.variables.map(variable => [variable.id, {
      status: 'evaluado', value: 1,
      reason: tool === 'gemma' ? GEMMA_REASON : 'Clef: amenaza de cancelación explícita en el ejemplo sintético.',
      evidence_message_ids: ['synthetic-client-message'],
    }]));
    return { ok: true, status: 200, async json() { return { ok: true, tool_key: tool,
      request_uuid: `${tool}-synthetic-response-${calls.length}`, method: 'POST', path: '/v1/chat/completions',
      upstream_status_code: 200, latency_ms: 1, response: { model: envelope.body.model,
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } } }; } };
  } });
  return { store, registry, conversation, calls, control, env };
}

function assertGemmaRecord(state, conversation, { started, finished }) {
  const records = state.evaluations.filter(evaluation => evaluation.profileId === 'gemma-local');
  assert.equal(records.length, 1);
  const evaluation = records[0], task = state.tasks.find(candidate => candidate.id === evaluation.taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.evaluationId, evaluation.id);
  assert.equal(evaluation.partial, false);
  assert.deepEqual(evaluation.validationErrors, []);
  assert.equal(evaluation.provider, 'gateway');
  assert.equal(evaluation.model, GEMMA_MODEL);
  assert.equal(evaluation.requestedProfileId, 'gemma-local');
  assert.equal(evaluation.requestedModel, GEMMA_MODEL);
  assert.equal(evaluation.modelConfiguration.id, 'gemma-local');
  assert.equal(evaluation.modelConfiguration.model, GEMMA_MODEL);
  assert.equal(evaluation.usedFallback, false);
  assert.match(evaluation.providerResponseId, /^gemma-synthetic-response-/);
  assert.ok(Date.parse(evaluation.createdAt) >= started && Date.parse(evaluation.createdAt) <= finished);
  for (const [key, value] of Object.entries(evaluationContext(conversation, state.catalog))) {
    assert.equal(evaluation[key], value, `Gemma retains its own ${key}`);
  }
  assert.equal(evaluation.results.length, 1);
  assert.deepEqual(evaluation.results[0], { variableId: FLAG, type: 'Flag', method: 'IA',
    status: 'evaluado', value: 1, reason: GEMMA_REASON,
    evidence: [{ messageId: conversation.messages[0].id, quote: conversation.messages[0].text }] });
  assert.deepEqual(evaluation.usage, { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 });
  return evaluation;
}

test('Gemma saves a complete independent record when Clef is absent and unconfigured', async () => {
  const { store, registry, conversation, calls, env } = fixture('single');
  assert.equal(registry.list().find(profile => profile.id === 'clef-local').configured, false);
  const started = Date.now();
  const job = await runEvaluationBatch(store, registry, { max: 1 });
  const state = await store.read();
  assert.equal(job.status, 'completed');
  assert.equal(job.total, 1);
  const evaluation = assertGemmaRecord(state, conversation, { started, finished: Date.now() });
  assert.deepEqual(calls, [{ tool: 'gemma', model: GEMMA_MODEL, variableIds: [FLAG] }]);
  assert.deepEqual(state.operationalRefs, [{ id: conversation.id, evaluationId: evaluation.id }]);
  const view = conversationView(state, conversation, undefined, true);
  assert.equal(view.evaluated, true);
  assert.equal(view.marks.length, 0, 'A saved single-model detection is not two-model consensus');
  assert.equal(view.dualDetected, false);
  assert.equal(view.variables[0].consensusSuppressed, true);
  assert.ok(!JSON.stringify(state).includes(env.AGENT_SHARED_TOKEN));
});

test('a failed Clef does not prevent Gemma persistence, and later Clef completion preserves Gemma unchanged', async () => {
  const { store, registry, conversation, calls, control, env } = fixture('dual');
  const started = Date.now();
  const job = await runEvaluationBatch(store, registry, { max: 1 });
  const state = await store.read();
  assert.equal(job.status, 'partial');
  assert.equal(job.completed, 1);
  assert.equal(job.failed, 1);
  assert.equal(state.tasks.find(task => task.profile.id === 'clef-local').status, 'failed');
  const originalGemma = assertGemmaRecord(state, conversation, { started, finished: Date.now() });
  const originalGemmaTask = state.tasks.find(task => task.id === originalGemma.taskId);
  const originalGemmaAttempts = state.attempts.filter(attempt => attempt.taskId === originalGemma.taskId);
  const gemmaCalls = calls.filter(call => call.tool === 'gemma').length;
  const before = conversationView(state, conversation, undefined, true);
  assert.equal(before.marks.length, 0);
  assert.equal(before.dualDetected, false);
  assert.equal(before.variables[0].automaticFlagVisible, false);
  assert.equal(before.variables[0].result.comparison.agreement, 'incomplete');
  assert.equal(before.variables[0].result.comparison.votes, 1);
  assert.equal(before.variables[0].result.comparison.detections, 1);

  control.clefAvailable = true;
  assert.equal((await (await resumeEvaluationBatch(store, registry, job.id)).completion).status, 'completed');
  const finished = await store.read();
  assert.equal(calls.filter(call => call.tool === 'gemma').length, gemmaCalls, 'Only pending Clef is called again');
  assert.deepEqual(finished.evaluations.find(evaluation => evaluation.id === originalGemma.id), originalGemma);
  assert.deepEqual(finished.tasks.find(task => task.id === originalGemmaTask.id), originalGemmaTask);
  assert.deepEqual(finished.attempts.filter(attempt => attempt.taskId === originalGemma.taskId), originalGemmaAttempts);
  assert.equal(finished.evaluations.length, 2);
  assert.equal(finished.operationalRefs.length, 1);
  const after = conversationView(finished, conversation, undefined, true);
  assert.equal(after.marks.length, 1);
  assert.equal(after.dualDetected, true);
  assert.equal(after.variables[0].result.comparison.detections, 2);
  assert.equal(after.variables[0].result.comparison.votes, 2);
  assert.deepEqual(after.variables[0].result.comparison.cells.find(cell => cell.profileId === 'gemma-local').result, originalGemma.results[0]);
  assert.ok(!JSON.stringify(finished).includes(env.AGENT_SHARED_TOKEN));
});
