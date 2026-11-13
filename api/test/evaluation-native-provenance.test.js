import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { AppError } from '../src/errors.js';
import { ModelRegistry } from '../src/model-registry.js';
import { runEvaluationBatch, resumeEvaluationBatch } from '../src/evaluation-service.js';
import { evaluationContext, digest } from '../src/evaluation-context.js';
import { comparisonRows, qualityMetrics } from '../src/comparisons.js';
import { operationalEvaluation } from '../src/operational-evaluation.js';

const instructionsHash = 'a'.repeat(64), adapterVersion = 'pulso-clef-decisions-v1';

test('adapter capacity limits count as missing while genuine model abstentions remain abstentions', () => {
  const unavailable = unavailabilityCode => ({ status: 'no_evaluado', value: null, unavailabilityCode });
  const results = [unavailable('evidence_capacity_exceeded'), unavailable('unsupported_descriptor'),
    { status: 'no_evaluado', value: null, reasonSource: 'adapter_template', decision: { classification: { choice: 'insufficient' } } },
    { status: 'evaluado', value: 1 }, { status: 'no_evaluado', value: null, error: { code: 'AI_UNAVAILABLE' } }, null];
  const rows = results.map(result => ({ sourceChanged: false, verdict: { mode: 'blind', outcome: 'present' },
    votes: result?.status === 'evaluado' ? 1 : 0, cells: [{ profileId: 'clef-local', status: 'completed', result }] }));
  const [metrics] = qualityMetrics(rows, [{ id: 'clef-local' }]);
  assert.equal(metrics.answered, 1);
  assert.equal(metrics.abstained, 1);
  assert.equal(metrics.missing, 4);
  assert.equal(metrics.answered + metrics.abstained + metrics.missing, metrics.total);
  assert.equal(metrics.n, 1);
  assert.equal(metrics.tp, 1);
});

function nativeMetadata(number, variables, errorCode) {
  const requestId = `synthetic-native-${number}`;
  return { protocol: 'systemone', adapterVersion, instructionsHash, requestIds: [requestId],
    requests: [{ requestId, stage: 'classification', variableIds: variables.map(v => v.id), durationMs: 2,
      inputBytes: 100, ...(errorCode ? { errorCode } : {}) }] };
}
function result(variable, native = false, number = 1) {
  return { variableId: variable.id, type: variable.type, method: variable.method, status: 'evaluado', value: 1,
    reason: native ? 'Decisión positiva del modelo; explicación de plantilla.' : 'GEMMA_PREDICTION_NEVER_INPUT',
    evidence: [{ messageId: 'm1', quote: 'Consulta sintética.' }], ...(native ? {
      reasonSource: 'adapter_template', evidenceSource: 'model_choice',
      decision: { stage1: { choice: 'present', probabilities: { present: 0.9, absent: 0.1 }, confidence: 0.9,
        requestId: `synthetic-native-${number}` } },
    } : {}) };
}
function fixture(nativeEvaluate) {
  const state = createState(false);
  state.catalog = state.catalog.filter(v => v.active && v.type === 'Flag' && v.method === 'IA').slice(0, 2);
  state.catalogVersions = state.catalog.map(v => ({ itemId: v.id, version: v.version, snapshot: structuredClone(v) }));
  state.conversations = [{ id: 'synthetic-native-case', country: 'HN', date: '2026-11-07', completed: true,
    client: { name: 'Cliente sintético' }, messages: [{ id: 'm1', actor: 'cliente', text: 'Consulta sintética.', timestamp: '2026-11-07T15:00:00Z' }] }];
  state.settings.aiPolicy = { mode: 'single', primaryId: 'gemma-local', fallbackId: null, version: 6 };
  state.settings.dailyEnabled = false;
  const calls = { gemma: 0, native: [] };
  const gemmaEvaluator = { configured: true, model: 'gemma-synthetic', baseUrl: 'http://gateway.synthetic', timeoutMs: 180000,
    toolKey: 'gemma', portalKey: 'portal-pulso', responseFormat: 'json_schema', maxTokens: 16000, temperature: 0,
    async evaluate(_conversation, variables) { calls.gemma++; return { model: this.model, results: variables.map(v => result(v)) }; } };
  const nativeEvaluator = { configured: true, protocol: 'systemone', adapterVersion, instructionsHash,
    model: 'clef-synthetic', baseUrl: gemmaEvaluator.baseUrl, timeoutMs: 180000, toolKey: 'gemma', portalKey: 'portal-pulso',
    async evaluate(conversation, variables, options) {
      assert.doesNotMatch(JSON.stringify({ conversation, variables, options }), /GEMMA_PREDICTION_NEVER_INPUT/);
      calls.native.push(variables.map(v => v.id));
      return nativeEvaluate(variables, calls.native.length);
    } };
  const registry = new ModelRegistry([
    { id: 'gemma-local', label: 'Gemma', provider: 'gateway', model: gemmaEvaluator.model, enabled: true, evaluator: gemmaEvaluator },
    { id: 'clef-local', label: 'Clef', provider: 'gateway', model: nativeEvaluator.model, enabled: true, evaluator: nativeEvaluator },
  ]);
  const originalGemmaHash = digest(['gateway', 'gemma-synthetic', 'http://gateway.synthetic', 180000,
    { toolKey: 'gemma', portalKey: 'portal-pulso', responseFormat: 'json_schema', maxTokens: 16000, temperature: 0 }]);
  assert.equal(registry.snapshot(registry.profiles[0]).configurationHash, originalGemmaHash);
  state.evaluations = Array.from({ length: 500 }, (_, index) => ({ id: `historical-${index}`, taskId: `historical-task-${index}`,
    conversationId: `historical-conversation-${index}`, profileId: 'gemma-local', purpose: 'operational', partial: false,
    modelConfiguration: registry.snapshot(registry.profiles[0]), ...evaluationContext(state.conversations[0], state.catalog),
    results: state.catalog.map(v => result(v)) }));
  const store = { async read() { return structuredClone(state); }, async readWithConversations() { return structuredClone(state); },
    async transaction(fn) { const draft = structuredClone(state), response = await fn(draft); Object.assign(state, draft); return structuredClone(response); } };
  return { state, registry, calls, store, nativeEvaluator };
}

test('native partial retry retains provenance and all requests without changing single-Gemma policy or 500 records', async () => {
  const f = fixture((variables, number) => {
    const metadata = nativeMetadata(number, variables);
    if (number === 2) {
      const error = new AppError(502, 'Fallo de transporte sintético.', 'AI_UNAVAILABLE');
      error.evaluationMetadata = nativeMetadata(number, variables, 'AI_UNAVAILABLE'); throw error;
    }
    return { model: 'clef-synthetic', responseId: metadata.requestIds[0], ...metadata,
      results: (number === 1 ? variables.slice(0, 1) : variables).map(v => result(v, true, number)),
      validationErrors: [], ...(number === 1 ? { failure: { code: 'AI_TRANSIENT' } } : {}) };
  });
  const historical = structuredClone(f.state.evaluations), settings = structuredClone(f.state.settings);
  const context = evaluationContext(f.state.conversations[0], f.state.catalog);
  const job = await runEvaluationBatch(f.store, f.registry, { purpose: 'comparison', modelIds: ['gemma-local', 'clef-local'], max: 1 });
  assert.equal(job.status, 'partial');
  const firstNativeTask = f.state.tasks.find(t => t.profile.id === 'clef-local');
  const retained = structuredClone(firstNativeTask.profileStates['clef-local'].results);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].reasonSource, 'adapter_template');
  assert.deepEqual(firstNativeTask.profileStates['clef-local'].requestIds, ['synthetic-native-1', 'synthetic-native-2']);
  const gemmaTask = structuredClone(f.state.tasks.find(t => t.profile.id === 'gemma-local'));
  const partialEvaluation = structuredClone(f.state.evaluations.at(-1));
  assert.equal(partialEvaluation.protocol, 'systemone');
  assert.equal(partialEvaluation.instructionsHash, instructionsHash);
  const resumed = await resumeEvaluationBatch(f.store, f.registry, job.id);
  assert.equal((await resumed.completion).status, 'completed');
  const completedTask = f.state.tasks.find(t => t.profile.id === 'clef-local');
  const completed = f.state.evaluations.find(e => e.id === completedTask.evaluationId);
  assert.deepEqual(f.calls.native, [f.state.catalog.map(v => v.id), [f.state.catalog[1].id], [f.state.catalog[1].id]]);
  assert.equal(f.calls.gemma, 1);
  assert.deepEqual(f.state.tasks.find(t => t.id === gemmaTask.id), gemmaTask);
  assert.deepEqual(completed.results.find(r => r.variableId === retained[0].variableId), retained[0]);
  assert.deepEqual(completed.requestIds, ['synthetic-native-1', 'synthetic-native-2', 'synthetic-native-3']);
  assert.equal(completed.requests.length, 3);
  assert.equal(new Set(completed.requests.map(r => r.attemptId)).size, 3);
  const attempts = f.state.attempts.filter(a => a.profileId === 'clef-local');
  assert.deepEqual(attempts.map(a => a.protocol), ['systemone', 'systemone', 'systemone']);
  assert.deepEqual(attempts.map(a => a.requestIds), completed.requestIds.map(id => [id]));
  assert.deepEqual(f.state.evaluations.find(e => e.id === partialEvaluation.id), partialEvaluation);
  assert.deepEqual(f.state.evaluations.slice(0, 500), historical);
  assert.deepEqual(f.state.settings, settings);
  assert.deepEqual(evaluationContext(f.state.conversations[0], f.state.catalog), context);
  assert.ok(f.state.tasks.every(t => JSON.stringify(t.context) === JSON.stringify(context)));
  assert.equal(f.state.evaluations.find(e => e.id === gemmaTask.evaluationId).protocol, undefined);
});

test('a native partial configuration failure keeps valid decisions and does not retry automatically', async () => {
  const f = fixture((variables, number) => ({ model: 'clef-synthetic', ...nativeMetadata(number, variables),
    results: [result(variables[0], true, number)], validationErrors: [], failure: { code: 'AI_CONFIGURATION' } }));
  const job = await runEvaluationBatch(f.store, f.registry, { purpose: 'comparison', modelIds: ['gemma-local', 'clef-local'], max: 1 });
  assert.equal(job.status, 'partial'); assert.equal(f.calls.native.length, 1);
  const task = f.state.tasks.find(t => t.profile.id === 'clef-local');
  assert.equal(task.error.code, 'AI_CONFIGURATION');
  assert.equal(task.profileStates['clef-local'].results[0].reasonSource, 'adapter_template');
});

test('chat memory failures persist their exact code without automatic retries and resume only missing decisions', async () => {
  const f = fixture((variables, number) => ({ model: 'clef-synthetic',
    results: (number === 1 ? variables.slice(0, 1) : variables).map(variable => result(variable)),
    validationErrors: [], ...(number === 1 ? { failure: { code: 'AI_RESOURCE_LIMIT' } } : {}) }));
  f.nativeEvaluator.protocol = 'chat';
  const historical = structuredClone(f.state.evaluations);
  const job = await runEvaluationBatch(f.store, f.registry, { purpose: 'comparison', modelIds: ['gemma-local', 'clef-local'], max: 1 });
  assert.equal(job.status, 'partial');
  assert.equal(f.calls.native.length, 1);
  const task = f.state.tasks.find(item => item.profile.id === 'clef-local');
  assert.equal(task.profile.protocol, 'chat');
  assert.equal(task.error.code, 'AI_RESOURCE_LIMIT');
  assert.deepEqual(f.state.attempts.filter(attempt => attempt.profileId === 'clef-local').map(attempt => [attempt.status, attempt.error.code]),
    [['partial', 'AI_RESOURCE_LIMIT']]);
  const retained = structuredClone(task.profileStates['clef-local'].results);
  assert.equal(retained.length, 1);
  const partial = structuredClone(f.state.evaluations.find(evaluation => evaluation.id === task.evaluationId));
  assert.deepEqual(partial.results.filter(item => item.status === 'evaluado'), retained);
  assert.equal(partial.results.find(item => item.variableId === f.state.catalog[1].id).status, 'no_evaluado');

  const resumed = await resumeEvaluationBatch(f.store, f.registry, job.id);
  assert.equal((await resumed.completion).status, 'completed');
  assert.deepEqual(f.calls.native, [f.state.catalog.map(variable => variable.id), [f.state.catalog[1].id]]);
  assert.equal(f.calls.gemma, 1);
  const completedTask = f.state.tasks.find(item => item.id === task.id);
  assert.equal(completedTask.error, null);
  const completed = f.state.evaluations.find(evaluation => evaluation.id === completedTask.evaluationId);
  assert.deepEqual(completed.results.find(item => item.variableId === retained[0].variableId), retained[0]);
  assert.deepEqual(f.state.evaluations.find(evaluation => evaluation.id === partial.id), partial);
  assert.deepEqual(f.state.evaluations.slice(0, historical.length), historical);
});

test('changed native instructions cannot be merged with an already retained decision', async () => {
  const f = fixture((variables, number) => ({ model: 'clef-synthetic', ...nativeMetadata(number, variables),
    ...(number > 1 ? { instructionsHash: 'b'.repeat(64) } : {}),
    results: (number === 1 ? variables.slice(0, 1) : variables).map(v => result(v, true, number)), validationErrors: [] }));
  const job = await runEvaluationBatch(f.store, f.registry, { purpose: 'comparison', modelIds: ['gemma-local', 'clef-local'], max: 1 });
  assert.equal(job.status, 'partial'); assert.equal(f.calls.native.length, 2);
  const task = f.state.tasks.find(t => t.profile.id === 'clef-local'), saved = task.profileStates['clef-local'];
  assert.equal(task.error.code, 'MODEL_CHANGED');
  assert.equal(saved.results.length, 1);
  assert.equal(saved.instructionsHash, instructionsHash);
  assert.deepEqual(saved.requestIds, ['synthetic-native-1']);
  assert.equal(saved.results[0].decision.stage1.requestId, 'synthetic-native-1');
});

test('native results vote only inside their explicit job and matching protocol/instructions snapshot', async () => {
  const f = fixture((variables, number) => ({ model: 'clef-synthetic', ...nativeMetadata(number, variables),
    results: variables.map(v => result(v, true, number)), validationErrors: [] }));
  const job = await runEvaluationBatch(f.store, f.registry, { purpose: 'comparison', modelIds: ['gemma-local', 'clef-local'], max: 1 });
  const sample = f.state.comparisons.find(s => s.jobId === job.id);
  assert.ok(comparisonRows(f.state, sample).every(row => row.votes === 2));
  const gemmaTask = f.state.tasks.find(t => t.profile.id === 'gemma-local');
  const gemmaEvaluation = f.state.evaluations.find(e => e.id === gemmaTask.evaluationId);
  gemmaEvaluation.jobId = 'historical-gemma-job';
  assert.ok(comparisonRows(f.state, sample).every(row => row.votes === 1), 'An old Gemma answer cannot be borrowed into a native comparison');
  gemmaEvaluation.jobId = job.id;
  const nativeTask = f.state.tasks.find(t => t.profile.id === 'clef-local');
  const original = structuredClone(f.state.evaluations.find(e => e.id === nativeTask.evaluationId));
  const mutations = [e => { delete e.protocol; }, e => { e.instructionsHash = 'b'.repeat(64); },
    e => { e.adapterVersion = 'other'; }, e => { e.modelConfiguration.configurationHash = 'b'.repeat(64); },
    e => { e.modelConfiguration.instructionsHash = 'b'.repeat(64); }, e => { e.jobId = 'historical-job'; }];
  for (const mutate of mutations) {
    const changed = structuredClone(original); mutate(changed);
    f.state.evaluations[f.state.evaluations.findIndex(e => e.id === original.id)] = changed;
    assert.ok(comparisonRows(f.state, sample).every(row => row.votes === 1));
  }
  f.state.evaluations[f.state.evaluations.findIndex(e => e.id === original.id)] = original;
  sample.modelProfiles[1] = { ...sample.modelProfiles[1], protocol: 'chat' };
  assert.ok(comparisonRows(f.state, sample).every(row => row.votes === 1), 'Native results cannot masquerade as historical chat');
  sample.modelProfiles[1] = structuredClone(nativeTask.profile);
  const activeJob = f.state.jobs.find(j => j.id === job.id); activeJob.mode = 'dual'; activeJob.purpose = 'operational';
  const anchor = f.state.evaluations.find(e => e.id === f.state.tasks.find(t => t.profile.id === 'gemma-local').evaluationId);
  assert.ok(operationalEvaluation(f.state, anchor).results.every(r => r.comparison.votes === 2));
  original.instructionsHash = 'b'.repeat(64);
  assert.ok(operationalEvaluation(f.state, anchor).results.every(r => r.comparison.votes === 1));
});
