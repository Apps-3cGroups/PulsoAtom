import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { registryFromEnv } from '../src/model-registry.js';
import { runEvaluationBatch, resumeEvaluationBatch } from '../src/evaluation-service.js';
import { runDailyTick } from '../src/daily-scheduler.js';

function fixture({ legacyPolicy = false, savedConfiguration = true } = {}) {
  const state = createState(false);
  state.catalog = state.catalog.filter(v => v.id === 'cliente_molesto');
  state.conversations = [{ id: 'local-runtime-synthetic', country: 'HN', completed: true, date: '2026-11-06',
    sourceCreatedAt: '2026-11-06T10:00:00.000Z', sourceUpdatedAt: '2026-11-06T10:00:00.000Z',
    messages: [{ id: 'm1', actor: 'cliente', text: 'Estoy molesto.', timestamp: '2026-11-06T10:00:00.000Z' }] }];
  state.settings = { ...state.settings, dailyEnabled: true, dailyStartedAt: '2026-11-05T00:00:00.000Z', dailyTime: '07:00', timezone: 'America/Tegucigalpa',
    aiPolicy: { mode: 'dual', primaryId: legacyPolicy ? 'openai-default' : 'clef-local', secondaryId: legacyPolicy ? 'gemini-default' : 'gemma-local', fallbackId: null, version: 1 } };
  const saved = { version: 1, profiles: ['clef', 'gemma'].map(name => ({ id: `${name}-local`, label: name, toolKey: `${name}-tool-saved`,
    model: `${name}-model-saved`, enabled: true, responseFormat: 'json_schema' })) };
  if (savedConfiguration) state.settings.localModelConfiguration = structuredClone(saved);
  const calls = [], control = { failGemma: false, beforeTransaction: null };
  const env = { GATEWAY_BASE_URL: 'http://gateway.example.test:9000', AGENT_SHARED_TOKEN: 'synthetic-private-token', GATEWAY_PORTAL_KEY: 'pulso-test',
    // Old public credentials cannot select a provider or supply a local model ID.
    OPENAI_API_KEY: 'synthetic-old-public-token', OPENAI_MODEL: 'old-public-model', OPENAI_EVALUATION_ENABLED: 'true',
    GEMINI_API_KEY: 'synthetic-old-other-token', GEMINI_MODEL: 'old-other-model', GEMINI_EVALUATION_ENABLED: 'true' };
  const registry = registryFromEnv({ env, fetchImpl: async (url, options) => {
    const envelope = JSON.parse(options.body);
    const toolKey = new URL(url).pathname.split('/')[3];
    assert.equal(new URL(url).origin, env.GATEWAY_BASE_URL);
    assert.equal(envelope.path, '/v1/chat/completions');
    assert.equal(envelope.method, 'POST');
    assert.equal(envelope.body.stream, false);
    const input = JSON.parse(envelope.body.messages.at(-1).content);
    calls.push({ toolKey, model: envelope.body.model, variables: input.variables.map(v => v.id) });
    const results = Object.fromEntries(input.variables.map(v => [v.id, { status: 'evaluado', value: 1,
      reason: 'Dato sintético explícito.', evidence_message_ids: control.failGemma && toolKey.startsWith('gemma') ? ['missing-message'] : ['m1'] }]));
    return { ok: true, status: 200, json: async () => ({ ok: true, tool_key: toolKey, request_uuid: `synthetic-request-${calls.length}`,
      method: 'POST', path: '/v1/chat/completions', upstream_status_code: 200, latency_ms: 1,
      response: { model: envelope.body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }] } }) };
  } });
  const store = {
    async read() { return structuredClone(state); },
    async readWithConversations() { return structuredClone(state); },
    async transaction(fn) {
      if (control.beforeTransaction) { const hook = control.beforeTransaction; control.beforeTransaction = null; await hook(state); }
      const draft = structuredClone(state); const result = await fn(draft); Object.assign(state, draft); return structuredClone(result);
    },
  };
  return { state, store, registry, calls, control, saved };
}

async function waitForJob(state, id) {
  for (let i = 0; i < 100; i++) {
    const job = state.jobs.find(j => j.id === id);
    if (job?.status !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('El trabajo sintético no terminó.');
}

test('a batch uses both model IDs and tools saved in Pulso without model identifiers in environment', async () => {
  const { state, store, registry, calls } = fixture();
  assert.equal(registry.configured, false);
  const job = await runEvaluationBatch(store, registry, { max: 1 });
  assert.equal(job.status, 'completed');
  assert.equal(job.total, 2);
  assert.deepEqual(calls.map(call => [call.toolKey, call.model]), [['clef-tool-saved', 'clef-model-saved'], ['gemma-tool-saved', 'gemma-model-saved']]);
  assert.ok(state.evaluations.every(e => e.provider === 'gateway' && !e.usedFallback));
  assert.deepEqual(state.evaluations.map(e => e.requestedModel), ['clef-model-saved', 'gemma-model-saved']);
});

test('scheduler skips pending/legacy policy without AI, then executes the saved local pair once per day', async () => {
  const { state, store, registry, calls, saved } = fixture({ legacyPolicy: true, savedConfiguration: false });
  const now = new Date('2026-11-06T13:00:00.000Z');
  assert.equal(await runDailyTick(store, registry, now), null);
  state.settings.localModelConfiguration = structuredClone(saved);
  assert.equal(await runDailyTick(store, registry, now), null, 'Saved profiles alone do not authorize a legacy public policy');
  assert.deepEqual(calls, []);
  assert.deepEqual(state.jobs, []);
  state.settings.aiPolicy = { mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local', fallbackId: null, version: 2 };
  const job = await runDailyTick(store, registry, now);
  assert.equal(job.scope, 'daily');
  assert.equal((await waitForJob(state, job.id)).status, 'completed');
  assert.equal(calls.length, 2);
  assert.equal(await runDailyTick(store, registry, now), null);
  assert.equal(state.jobs.length, 1);
  assert.equal(calls.length, 2);
});

test('a saved configuration edit between initial read and job transaction prevents stale model execution', async () => {
  const { state, store, registry, calls, control } = fixture();
  control.beforeTransaction = current => {
    current.settings.localModelConfiguration.profiles[0].toolKey = 'changed-tool';
    current.settings.localModelConfiguration.version++;
  };
  await assert.rejects(runEvaluationBatch(store, registry, { max: 1 }), { code: 'MODEL_CHANGED' });
  assert.deepEqual(calls, []);
  assert.deepEqual(state.jobs, []);
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.evaluations, []);
});

test('disabling a model at the transaction boundary prevents creating a stale batch', async () => {
  const { state, store, registry, calls, control } = fixture();
  control.beforeTransaction = current => { current.settings.localModelConfiguration.profiles[1].enabled = false; };
  await assert.rejects(runEvaluationBatch(store, registry, { max: 1 }), { code: 'AI_CONFIGURATION' });
  assert.deepEqual(calls, []);
  assert.deepEqual(state.jobs, []);
});

test('a saved model edit at the resume transaction prevents calls and preserves pending task rounds', async () => {
  const { state, store, registry, calls, control } = fixture();
  control.failGemma = true;
  const job = await runEvaluationBatch(store, registry, { max: 1 });
  assert.equal(job.status, 'partial');
  const pendingBefore = structuredClone(state.tasks.filter(t => t.status !== 'completed'));
  const callCount = calls.length;
  control.failGemma = false;
  control.beforeTransaction = current => { current.settings.localModelConfiguration.profiles[1].model = 'changed-gemma-model'; };
  await assert.rejects(resumeEvaluationBatch(store, registry, job.id), { code: 'MODEL_CHANGED' });
  assert.equal(calls.length, callCount);
  assert.deepEqual(state.tasks.filter(t => t.status !== 'completed'), pendingBefore);
  assert.equal(state.jobs[0].status, 'partial');
});
