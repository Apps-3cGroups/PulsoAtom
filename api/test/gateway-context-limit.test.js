import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayApiClient } from '../src/services/gatewayApiClient.js';
import { GatewayEvaluator } from '../src/gateway-evaluator.js';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { catalogReferences, evaluationContext } from '../src/evaluation-context.js';
import { supportsCodeVariable, evaluateCodeVariables } from '../src/code-evaluator.js';
import { resumeEvaluationBatch } from '../src/evaluation-service.js';

const base = { baseUrl: 'http://gateway.synthetic', token: 'PRIVATE_SYNTHETIC_TOKEN', portalKey: 'portal-pulso', timeoutMs: 180000 };
const operation = { toolKey: 'gemma', method: 'POST', path: '/v1/chat/completions' };
const envelope = (response, status = 400, overrides = {}) => ({ ok: status === 200, tool_key: 'gemma',
  request_uuid: 'synthetic-request-id', method: 'POST', path: '/v1/chat/completions', upstream_status_code: status, response, ...overrides });
const mock = body => ({ ok: true, status: 200, async json() { return body; } });
const contextError = 'Trying to keep the first 9000 tokens when context overflows. However, the model is loaded with context length of only 4096 tokens.';
const clientFor = response => new GatewayApiClient({ ...base, fetchImpl: async () => mock(response) });

test('successful Gateway HTTP envelopes recognize explicit upstream chat context limits without exposing content', async () => {
  const bodies = [contextError, { error: contextError }, { message: contextError },
    { error: { message: contextError } }, { error: { error: contextError } }, { detail: { error: { message: contextError } } },
    { error: { code: 'context_length_exceeded' } }, { error: 'Context window limit exceeded.' },
    { error: 'The prompt length exceeds the maximum context window.' },
    { error: "This model's maximum context length is 4096 tokens. However, you requested 9000 tokens." },
    { error: 'Error: Cannot truncate prompt with n_keep (9000) >= n_ctx (4096)' },
    { error: 'The number of tokens to keep from the initial prompt is greater than the context length. Try to load the model with a larger context length, or provide a shorter input.' }];
  for (const status of [400, 413, 422]) for (const body of bodies) {
    const raw = typeof body === 'string' ? `${body} ${base.token}` : { ...body, content: base.token, url: base.baseUrl };
    await assert.rejects(clientFor(envelope(raw, status)).invoke(operation), error => {
      assert.equal(error.code, 'AI_CONTEXT_LIMIT');
      assert.equal(error.message, 'La conversación supera el contexto admitido por el modelo. Queda pendiente de revisión.');
      assert.equal(error.details, undefined);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE_SYNTHETIC_TOKEN|gateway\.synthetic|9000|4096/);
      return true;
    });
  }
});

test('unknown input errors, schema/configuration errors and quoted transcript phrases remain configuration failures', async () => {
  for (const body of [null, {}, { error: 'Bad request' }, { error: 'Invalid JSON schema: context length exceeded' },
    { error: { code: 'invalid_schema', message: 'The context length field must be an integer.' } },
    { error: 'Invalid request. Quoted transcript: "Context window exceeded".' },
    { error: '"Context window exceeded" was supplied in the user content.' },
    { error: 'The number of tokens to keep from the initial prompt is not greater than the context length.' },
    { error: 'Invalid schema: The number of tokens to keep from the initial prompt is greater than the context length.' },
    { error: 'Quoted conversation: "The number of tokens to keep from the initial prompt is greater than the context length."' },
    { error: 'The number of tokens to keep from the initial prompt is greater than the configured schema size.' },
    { prompt: contextError }, { messages: [{ content: contextError }] }, { error: { content: contextError } },
    { error: { details: { transcript: contextError } } }, { error: [{ message: contextError }] },
    { error: { error: { error: { error: { message: contextError } } } } },
    { error: contextError + 'x'.repeat(8192) }]) {
    await assert.rejects(clientFor(envelope(body)).invoke(operation), { code: 'AI_CONFIGURATION' });
  }
  for (const status of [401, 403, 404]) {
    await assert.rejects(clientFor(envelope({ error: contextError }, status)).invoke(operation), { code: 'AI_CONFIGURATION' });
  }
  for (const status of [408, 429, 500, 502]) {
    await assert.rejects(clientFor(envelope({ error: contextError }, status)).invoke(operation), { code: 'AI_TRANSIENT' });
  }
  for (const changed of [{ method: 'GET', path: '/v1/models' }, { method: 'POST', path: '/v1/systemone' }]) {
    await assert.rejects(clientFor(envelope({ error: contextError }, 400, changed)).invoke({ ...operation, ...changed }), { code: 'AI_CONFIGURATION' });
  }
});

test('outer HTTP errors are not parsed as upstream context errors and successful payloads are unchanged', async () => {
  let read = false;
  const client = new GatewayApiClient({ ...base, fetchImpl: async () => ({ status: 400, ok: false,
    async json() { read = true; return envelope({ error: contextError }); } }) });
  await assert.rejects(client.invoke(operation), { code: 'AI_CONFIGURATION' });
  assert.equal(read, false);
  const payload = { model: 'clef-flash', error: contextError };
  assert.deepEqual((await clientFor(envelope(payload, 200)).invoke(operation)).response, payload);
});

test('a context-limited Clef case stays partially unevaluated while another completes without retries, fallback or Gemma calls', async () => {
  const state = createState(false), calls = [], maintenanceId = 'synthetic-context-maintenance';
  const flags = state.catalog.filter(v => v.active && !v.retired && v.type === 'Flag' && v.method === 'IA').slice(0, 2);
  const codeVariable = state.catalog.find(v => v.active && !v.retired && supportsCodeVariable(v));
  assert.ok(codeVariable);
  state.catalog = [...flags, codeVariable];
  state.catalogVersions = state.catalog.map(v => ({ itemId: v.id, version: v.version, snapshot: structuredClone(v) }));
  state.settings = { ...state.settings, dailyEnabled: false, evaluationMaintenance: maintenanceId,
    aiPolicy: { mode: 'single', primaryId: 'gemma-local', fallbackId: null, version: 1 } };
  state.conversations = ['large', 'small'].map(id => ({ id, country: 'HN', date: '2026-11-07', completed: true,
    messages: [{ id: `${id}-m1`, actor: 'cliente', text: 'Consulta sintética.', timestamp: '2026-11-07T15:00:00Z' }] }));
  const clef = new GatewayEvaluator({ ...base, model: 'clef-flash', toolKey: 'gemma', fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body), input = JSON.parse(request.body.messages.at(-1).content);
    const id = input.mensajes[0].id.split('-')[0]; calls.push(id);
    if (id === 'large') return mock(envelope({ error: { message: contextError } }));
    return mock(envelope({ model: 'clef-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results:
      Object.fromEntries(input.variables.map(v => [v.id, { status: 'evaluado', value: 0, reason: 'Evento ausente en el ejemplo.', evidence_message_ids: [] }])) }) } }] }, 200));
  } });
  const registry = new ModelRegistry([{ id: 'gemma-local', label: 'Gemma', provider: 'gateway', model: 'synthetic-gemma', enabled: true,
    evaluator: { configured: true, async evaluate() { assert.fail('Gemma must not be called'); } } },
  { id: 'clef-local', label: 'Clef', provider: 'gateway', model: 'clef-flash', enabled: true, evaluator: clef }]);
  const profiles = ['gemma-local', 'clef-local'].map(id => registry.snapshot(registry.resolve(id)));
  const job = { id: 'synthetic-context-job', purpose: 'comparison', mode: 'single', status: 'interrupted', maintenanceId,
    modelProfiles: profiles, conversationIds: state.conversations.map(c => c.id), catalogVersions: catalogReferences(state.catalog),
    createdAt: '2026-11-07T16:00:00Z', total: 4, caseCount: 2, concurrency: 1, completed: 2, failed: 0 };
  state.jobs = [job]; state.tasks = state.conversations.flatMap(conversation => profiles.map(profile => ({ id: `${conversation.id}-${profile.id}`,
    jobId: job.id, conversationId: conversation.id, profile, fallback: null, codeResults: evaluateCodeVariables(conversation, [codeVariable]),
    context: evaluationContext(conversation, state.catalog), status: profile.id === 'gemma-local' ? 'completed' : 'pending', round: 0,
    evaluationId: profile.id === 'gemma-local' ? `original-${conversation.id}` : null, error: null })));
  state.evaluations = state.conversations.map(c => ({ id: `original-${c.id}`, conversationId: c.id, profileId: 'gemma-local', purpose: 'operational', results: [] }));
  state.operationalRefs = state.conversations.map(c => ({ id: c.id, evaluationId: `original-${c.id}` }));
  const originals = structuredClone(state.evaluations), refs = structuredClone(state.operationalRefs);
  const gemmaTasks = structuredClone(state.tasks.filter(t => t.profile.id === 'gemma-local'));
  const store = { async read() { return structuredClone(state); }, async readWithConversations({ conversationIds }) {
    return { ...structuredClone(state), conversations: structuredClone(state.conversations.filter(c => conversationIds.includes(c.id))) };
  }, async transaction(fn) { const draft = structuredClone(state), result = await fn(draft); Object.assign(state, draft); return structuredClone(result); } };
  const execution = await resumeEvaluationBatch(store, registry, job.id, { profileIds: ['clef-local'] });
  assert.equal((await execution.completion).status, 'partial');
  assert.deepEqual(calls, ['large', 'small']);
  const large = state.tasks.find(t => t.id === 'large-clef-local'), small = state.tasks.find(t => t.id === 'small-clef-local');
  assert.equal(large.status, 'partial'); assert.equal(large.error.code, 'AI_CONTEXT_LIMIT');
  assert.equal(small.status, 'completed');
  const result = state.evaluations.find(e => e.id === large.evaluationId);
  assert.equal(result.usedFallback, false); assert.equal(result.partial, true);
  for (const flag of flags) {
    const item = result.results.find(r => r.variableId === flag.id);
    assert.equal(item.status, 'no_evaluado'); assert.equal(item.value, null); assert.equal(item.error.code, 'AI_CONTEXT_LIMIT');
  }
  assert.equal(state.attempts.length, 2); assert.ok(state.attempts.every(a => a.profileId === 'clef-local'));
  assert.deepEqual(state.evaluations.filter(e => e.profileId === 'gemma-local'), originals);
  assert.deepEqual(state.tasks.filter(t => t.profile.id === 'gemma-local'), gemmaTasks);
  assert.deepEqual(state.operationalRefs, refs);
});
