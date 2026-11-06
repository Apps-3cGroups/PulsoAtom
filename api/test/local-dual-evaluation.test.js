import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { registryFromEnv } from '../src/model-registry.js';
import { runEvaluationBatch, resumeEvaluationBatch } from '../src/evaluation-service.js';
import { conversationView } from '../src/domain.js';

const FLAG = 'cliente_amenazo_cancelar_pedido';
const SECOND_FLAG = 'cliente_queja_precio';
const METRIC = 'num_mensajes_cliente';
const env = {
  AI_MODEL_PROFILES: JSON.stringify([
    { id: 'clef-local', label: 'Clef', provider: 'gateway', envPrefix: 'CLEF' },
    { id: 'gemma-local', label: 'Gemma', provider: 'gateway', envPrefix: 'GEMMA' },
  ]),
  GATEWAY_BASE_URL: 'http://gateway.synthetic:9000', GATEWAY_PORTAL_KEY: 'pulsoAtom', AGENT_SHARED_TOKEN: 'synthetic-local-token',
  CLEF_TOOL_KEY: 'clef', CLEF_MODEL: 'clef-synthetic-exact', CLEF_EVALUATION_ENABLED: 'true',
  GEMMA_TOOL_KEY: 'gemma', GEMMA_MODEL: 'gemma-synthetic-exact', GEMMA_EVALUATION_ENABLED: 'true',
  // Old cloud variables must not reintroduce profiles or public calls.
  OPENAI_MODEL: 'unused-synthetic-cloud', OPENAI_API_KEY: 'unused-synthetic-key', OPENAI_EVALUATION_ENABLED: 'true',
  GEMINI_MODEL: 'unused-synthetic-cloud', GEMINI_API_KEY: 'unused-synthetic-key', GEMINI_EVALUATION_ENABLED: 'true',
};

function fixture() {
  const state = createState(false);
  state.catalog.forEach(v => { v.active = [FLAG, SECOND_FLAG, METRIC].includes(v.id); });
  state.conversations = Array.from({ length: 5 }, (_, i) => {
    const id = `synthetic-${i + 1}`;
    return { id, country: 'HN', countryName: 'Honduras', date: '2026-11-06', completed: true,
      startedAt: `2026-11-06T15:0${i}:00Z`, endedAt: `2026-11-06T15:0${i}:30Z`,
      client: { name: `Cliente sintético ${i + 1}` }, agent: { id: 'synthetic-agent', name: 'Asesor sintético' }, media: [], topics: [],
      messages: [
        { id: `${id}-client`, actor: 'cliente', text: 'Si el pedido no llega hoy lo voy a cancelar.', timestamp: `2026-11-06T15:0${i}:00Z` },
        { id: `${id}-agent`, actor: 'humano', text: 'Voy a consultar el estado de su entrega.', timestamp: `2026-11-06T15:0${i}:30Z` },
      ] };
  });
  state.settings.aiPolicy = { mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local', fallbackId: null, version: 2 };
  const store = {
    async read() { return structuredClone(state); },
    async readWithConversations() { return structuredClone(state); },
    async transaction(fn) { const draft = structuredClone(state); const result = await fn(draft); Object.assign(state, draft); return structuredClone(result); },
  };
  return { state, store };
}

test('five conversations receive independent Clef/Gemma results through Gateway; partial replies and retries never inflate consensus', async () => {
  const { state, store } = fixture();
  const requests = [];
  let failedGemmaAvailable = false;
  const registry = registryFromEnv({ env, fetchImpl: async (url, options) => {
    assert.ok(url.startsWith(env.GATEWAY_BASE_URL + '/v1/tools/'));
    assert.equal(options.headers['X-Gateway-Token'], env.AGENT_SHARED_TOKEN);
    const envelope = JSON.parse(options.body);
    assert.equal(envelope.path, '/v1/chat/completions');
    assert.equal(envelope.body.stream, false);
    const tool = url.includes('/clef/') ? 'clef' : 'gemma';
    const input = JSON.parse(envelope.body.messages.at(-1).content);
    const id = input.mensajes[0].id.replace(/-client$/, '');
    const requested = input.variables.map(v => v.id);
    requests.push({ url, tool, id, input, requested, messages: envelope.body.messages });
    const attempt = requests.filter(r => r.tool === tool && r.id === id).length;
    if (id === 'synthetic-5' && tool === 'gemma' && !failedGemmaAvailable) return { ok: false, status: 503 };
    const results = {};
    for (const variableId of requested) {
      if (id === 'synthetic-4' && tool === 'gemma' && attempt === 1 && variableId === SECOND_FLAG) continue;
      const value = variableId !== FLAG || id === 'synthetic-4' || (id === 'synthetic-2' && tool === 'gemma') ? 0
        : id === 'synthetic-3' && tool === 'gemma' ? null : 1;
      results[variableId] = { status: value === null ? 'no_evaluado' : 'evaluado', value,
        reason: `${tool === 'clef' ? 'Clef' : 'Gemma'}: justificación sintética de ${variableId}.`,
        evidence_message_ids: value === 1 ? [input.mensajes[0].id] : [] };
    }
    return { ok: true, status: 200, async json() { return { ok: true, tool_key: tool,
      request_uuid: `synthetic-gateway-${requests.length}`, method: 'POST', path: '/v1/chat/completions', upstream_status_code: 200,
      response: { model: envelope.body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } } }; } };
  } });
  assert.deepEqual(registry.list().map(p => [p.id, p.provider, p.model]), [
    ['clef-local', 'gateway', env.CLEF_MODEL], ['gemma-local', 'gateway', env.GEMMA_MODEL],
  ]);
  const options = { max: 5, conversationIds: state.conversations.map(c => c.id), pendingOnly: false, idempotencyKey: 'synthetic-five-local' };
  const job = await runEvaluationBatch(store, registry, options);
  assert.equal(job.total, 10);
  assert.equal(job.completed, 9);
  assert.equal(job.failed, 1);
  assert.equal(job.status, 'partial');
  assert.equal(state.tasks.length, 10);
  assert.equal(state.evaluations.length, 10); // The failed AI task still preserves its valid shared code result.
  assert.equal(requests.length, 12);
  assert.equal(state.operationalRefs.length, 5);
  assert.ok(state.evaluations.every(e => e.provider === 'gateway' && [env.CLEF_MODEL, env.GEMMA_MODEL].includes(e.model)));
  assert.ok(state.evaluations.filter(e => !e.partial).every(e => e.providerResponseId.startsWith('synthetic-gateway-')));
  assert.ok(!JSON.stringify(state).includes(env.AGENT_SHARED_TOKEN));

  for (const c of state.conversations) {
    const [clef, gemma] = ['clef', 'gemma'].map(tool => requests.find(r => r.id === c.id && r.tool === tool));
    assert.deepEqual(clef.messages, gemma.messages, 'Both models receive the same original input/checklist');
    assert.deepEqual([...clef.requested].sort(), [FLAG, SECOND_FLAG].sort(), 'Code metrics must not be sent to the models');
    const tasks = state.tasks.filter(t => t.conversationId === c.id);
    assert.deepEqual(tasks[0].codeResults, tasks[1].codeResults);
    const view = conversationView(state, c, undefined, true);
    const metric = view.metrics.find(v => v.id === METRIC);
    assert.equal(metric.result.value, 1);
    assert.equal(metric.result.comparison, undefined, 'Shared code metrics cannot vote as AI');
  }
  const flag = id => conversationView(state, state.conversations.find(c => c.id === id), undefined, true).variables.find(v => v.id === FLAG);
  const agreed = flag('synthetic-1');
  assert.equal(agreed.kind, 'critical');
  assert.equal(agreed.result.comparison.detections, 2);
  assert.equal(agreed.result.comparison.votes, 2);
  assert.equal(agreed.result.comparison.agreement, 'agree-positive');
  assert.deepEqual(agreed.result.comparison.cells.map(cell => cell.label), ['Clef', 'Gemma']);
  assert.ok(agreed.result.comparison.cells[0].result.reason.startsWith('Clef:'));
  assert.ok(agreed.result.comparison.cells[1].result.reason.startsWith('Gemma:'));
  assert.ok(agreed.result.comparison.cells.every(cell => cell.result.evidence[0].messageId === 'synthetic-1-client'));
  assert.equal(agreed.result.comparison.commonEvidence, true);

  assert.equal(flag('synthetic-2').kind, null);
  assert.equal(flag('synthetic-2').result.comparison.agreement, 'disagree');
  assert.equal(flag('synthetic-3').kind, null);
  assert.equal(flag('synthetic-3').result.comparison.agreement, 'incomplete');
  assert.equal(flag('synthetic-3').result.comparison.votes, 1);
  assert.equal(flag('synthetic-3').result.comparison.cells[1].result.value, null);
  assert.equal(flag('synthetic-5').kind, null);
  assert.equal(flag('synthetic-5').result.comparison.agreement, 'incomplete');
  assert.equal(flag('synthetic-5').result.comparison.cells[1].result.status, 'no_evaluado');
  assert.equal(flag('synthetic-5').result.comparison.cells[1].result.value, null);
  assert.equal(flag('synthetic-5').result.comparison.cells[1].result.error.code, 'AI_TRANSIENT');
  const partialRequests = requests.filter(r => r.id === 'synthetic-4' && r.tool === 'gemma');
  assert.deepEqual([...partialRequests[0].requested].sort(), [FLAG, SECOND_FLAG].sort());
  assert.deepEqual(partialRequests[1].requested, [SECOND_FLAG]);

  const clefCalls = requests.filter(r => r.tool === 'clef').length;
  failedGemmaAvailable = true;
  await (await resumeEvaluationBatch(store, registry, job.id)).completion;
  assert.equal(state.jobs.find(j => j.id === job.id).status, 'completed');
  assert.equal(state.tasks.length, 10);
  assert.equal(state.evaluations.length, 11); // Preserve the failed historical attempt; current task references are unique.
  assert.equal(new Set(state.tasks.map(t => t.evaluationId)).size, 10);
  assert.equal(requests.length, 13);
  assert.equal(requests.filter(r => r.tool === 'clef').length, clefCalls);
  assert.equal(flag('synthetic-5').result.comparison.detections, 2);
  assert.equal(flag('synthetic-5').result.comparison.votes, 2);
  assert.equal(flag('synthetic-5').kind, 'critical');
  const resumed = await runEvaluationBatch(store, registry, options);
  assert.equal(resumed.id, job.id);
  assert.equal(requests.length, 13, 'Idempotency does not repeat the two models');
});
