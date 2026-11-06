import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { localPilotProfiles, preflightLocalModels, latestFiveConversations, createLocalPilotPlan, executeLocalPilot } from '../src/local-model-pilot.js';
import { resumeEvaluationBatch } from '../src/evaluation-service.js';

function fixture() {
  const state = createState(false);
  state.catalog = state.catalog.filter(v => v.id === 'cliente_molesto');
  state.conversations = Array.from({ length: 6 }, (_, index) => ({ id: String(index + 1), country: 'HN', completed: false,
    date: '2026-11-06', startedAt: '2026-10-01T12:00:00Z', lastActivityAt: `2026-11-06T12:0${index}:00Z`,
    client: { name: 'Cliente sintético privado' }, messages: [{ id: `m-${index}`, actor: 'cliente', text: 'Estoy molesto.', timestamp: `2026-11-06T12:0${index}:00Z` }] }));
  state.settings.dailyEnabled = true;
  state.settings.evaluationMaintenance = null;
  state.settings.aiPolicy = { mode: 'dual', primaryId: 'old-gpt', secondaryId: 'old-gemini', fallbackId: null, version: 4 };
  const calls = [], control = { partial: false, invalidProbe: false, inactive: false, missingModel: false, mutations: 0 };
  const registry = new ModelRegistry(['clef', 'gemma'].map(name => ({ id: `${name}-local`, label: name, model: `${name}-synthetic`, provider: 'gateway', enabled: true,
    evaluator: { configured: true, baseUrl: 'http://gateway.example.test', model: `${name}-synthetic`, toolKey: name, timeoutMs: 1000,
      async discovery() { return { catalog: { tools: [{ key: name, status: control.inactive ? 'inactive' : 'active' }] },
        models: { data: control.missingModel ? [] : [{ id: `${name}-synthetic` }] }, requestId: 'synthetic-discovery' }; },
      async evaluate(conversation, variables) {
        calls.push({ name, id: conversation.id, variables: variables.map(v => v.id) });
        const probe = conversation.id === 'pulso-local-connectivity-synthetic';
        if (control.partial && !probe && name === 'gemma') return { model: `${name}-synthetic`, results: [], validationErrors: variables.map(v => ({ variableId: v.id, rules: ['synthetic_partial'] })) };
        return { model: `${name}-synthetic`, responseId: 'synthetic-probe', validationErrors: [], results: variables.map(v => {
          const value = probe ? Number(v.id === 'local_probe_present' && !control.invalidProbe) : 1;
          return { variableId: v.id, type: v.type, method: v.method, status: 'evaluado', value, reason: 'Caso sintético.',
            evidence: value ? [{ messageId: conversation.messages[0].id, quote: conversation.messages[0].text }] : [] };
        }) };
      },
    } })));
  const store = {
    async read() { return structuredClone(state); },
    async readWithConversations() { return structuredClone(state); },
    async transaction(fn) { const draft = structuredClone(state); const result = await fn(draft); Object.assign(state, draft); control.mutations++; return structuredClone(result); },
  };
  const plan = async () => createLocalPilotPlan(state, registry, await preflightLocalModels(registry));
  const reset = () => { state.settings.dailyEnabled = false; state.settings.evaluationMaintenance = 'reset-synthetic'; };
  return { state, registry, store, calls, control, plan, reset };
}

function savedConfigurationFixture() {
  const context = fixture();
  const { state, registry } = context;
  state.settings.localModelConfiguration = { version: 1, profiles: registry.profiles.map(profile => ({
    id: profile.id, label: `Guardado ${profile.label}`, toolKey: `saved-${profile.evaluator.toolKey}`,
    model: `saved-${profile.model}`, enabled: true, responseFormat: 'json_object',
  })) };
  // The environment registry starts unavailable. Resolving the persisted
  // settings must happen before checking readiness, discovery or execution.
  registry.profiles.forEach(profile => { profile.enabled = false; });
  registry.forState = current => new ModelRegistry(current.settings.localModelConfiguration.profiles.map(spec => {
    const original = registry.profiles.find(profile => profile.id === spec.id);
    return { ...original, ...spec, provider: 'gateway', evaluator: { ...original.evaluator,
      model: spec.model, toolKey: spec.toolKey, responseFormat: spec.responseFormat,
      async discovery() { return { catalog: { tools: [{ key: spec.toolKey, status: 'active' }] }, models: { data: [{ id: spec.model }] }, requestId: 'saved-discovery' }; },
      async evaluate(conversation, variables) { return { ...await original.evaluator.evaluate(conversation, variables), model: spec.model }; },
    } };
  }));
  context.plan = async () => createLocalPilotPlan(state, registry, await preflightLocalModels(registry, state));
  return context;
}

test('preflight fails closed for public providers, duplicate models and unavailable Gateway discovery', async () => {
  const { registry, control, calls } = fixture();
  registry.profiles[0].provider = 'openai';
  assert.throws(() => localPilotProfiles(registry), { code: 'LOCAL_MODELS_REQUIRED' });
  registry.profiles[0].provider = 'gateway';
  registry.profiles[1].model = registry.profiles[0].model;
  assert.throws(() => localPilotProfiles(registry), { code: 'DUPLICATE_MODEL' });
  registry.profiles[1].model = 'gemma-synthetic';
  control.inactive = true;
  await assert.rejects(preflightLocalModels(registry), { code: 'GATEWAY_TOOL_UNAVAILABLE' });
  assert.deepEqual(calls, []);
  control.inactive = false; control.missingModel = true;
  await assert.rejects(preflightLocalModels(registry), { code: 'LOCAL_MODEL_UNAVAILABLE' });
  control.missingModel = false; control.invalidProbe = true;
  await assert.rejects(preflightLocalModels(registry), { code: 'LOCAL_PREFLIGHT_FAILED' });
  assert.ok(calls.every(c => c.id === 'pulso-local-connectivity-synthetic'));
});

test('plan selects five latest by activity including open chats without persisting transcripts or changing state', async () => {
  const { state, plan, calls, control } = fixture();
  const before = structuredClone(state);
  const manifest = await plan();
  assert.deepEqual(manifest.conversations.map(c => c.id), ['6', '5', '4', '3', '2']);
  assert.ok(manifest.conversations.every(c => c.sourceHash && c.catalogHash && c.promptHash && c.rulesVersion));
  assert.ok(!JSON.stringify(manifest).includes('Cliente sintético privado'));
  assert.ok(!JSON.stringify(manifest).includes('Estoy molesto.'));
  assert.deepEqual(state, before);
  assert.equal(control.mutations, 0);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.id === 'pulso-local-connectivity-synthetic'));
  const tied = state.conversations.map(c => ({ ...c, lastActivityAt: '2026-11-06T15:00:00Z' }));
  assert.deepEqual(latestFiveConversations(tied).map(c => c.id), ['6', '5', '4', '3', '2']);
  assert.throws(() => latestFiveConversations(tied.slice(0, 4)), { code: 'LOCAL_SAMPLE_UNAVAILABLE' });
});

test('apply requires explicit matching maintenance and paused daily; changed source cannot trigger calls or writes', async () => {
  const { state, registry, store, plan, reset, calls, control } = fixture();
  const manifest = await plan();
  await assert.rejects(executeLocalPilot(store, registry, manifest), { code: 'LOCAL_RESET_REQUIRED' });
  reset(); state.settings.dailyEnabled = true;
  await assert.rejects(executeLocalPilot(store, registry, manifest, { maintenanceId: 'reset-synthetic' }), { code: 'DAILY_MUST_BE_PAUSED' });
  state.settings.dailyEnabled = false;
  state.conversations[5].messages[0].text = 'El contenido cambió.';
  await assert.rejects(executeLocalPilot(store, registry, manifest, { maintenanceId: 'reset-synthetic' }), { code: 'SOURCE_CHANGED' });
  assert.equal(control.mutations, 0);
  assert.equal(calls.length, 2);
});

test('a changed source can be replanned under its explicit reset only before any pilot results exist', async () => {
  const { state, registry, reset, control } = fixture();
  const preflight = await preflightLocalModels(registry);
  reset();
  assert.throws(() => createLocalPilotPlan(state, registry, preflight), { code: 'MAINTENANCE_ALREADY_ACTIVE' });
  assert.throws(() => createLocalPilotPlan(state, registry, preflight, { maintenanceId: 'other-reset' }), { code: 'MAINTENANCE_ALREADY_ACTIVE' });
  state.conversations[5].messages[0].text = 'Contenido actualizado antes de iniciar.';
  const plan = createLocalPilotPlan(state, registry, preflight, { maintenanceId: 'reset-synthetic' });
  assert.equal(plan.maintenanceId, 'reset-synthetic');
  assert.equal(plan.conversations.length, 5);
  assert.equal(control.mutations, 0);
  state.settings.dailyEnabled = true;
  assert.throws(() => createLocalPilotPlan(state, registry, preflight, { maintenanceId: 'reset-synthetic' }), { code: 'MAINTENANCE_ALREADY_ACTIVE' });
  state.settings.dailyEnabled = false;
  for (const key of ['evaluations', 'jobs', 'tasks', 'operationalRefs']) {
    const previous = state[key]; state[key] = [{ id: 'already-started' }];
    assert.throws(() => createLocalPilotPlan(state, registry, preflight, { maintenanceId: 'reset-synthetic' }), { code: 'MAINTENANCE_ALREADY_ACTIVE' });
    state[key] = previous;
  }
});

test('apply persists ten local evaluations, versions the policy, releases only its maintenance and leaves daily paused', async () => {
  const { state, registry, store, plan, reset, calls } = fixture();
  const manifest = await plan(); reset();
  const summary = await executeLocalPilot(store, registry, manifest, { maintenanceId: 'reset-synthetic' });
  assert.deepEqual({ completed: summary.completed, partial: summary.partial, failed: summary.failed, released: summary.maintenanceReleased }, { completed: 10, partial: 0, failed: 0, released: true });
  assert.equal(state.settings.dailyEnabled, false);
  assert.equal(state.settings.evaluationMaintenance, null);
  assert.deepEqual(state.settings.aiPolicy.mode, 'dual');
  assert.equal(state.settings.aiPolicy.fallbackId, null);
  assert.equal(state.settings.aiPolicy.primaryId, 'clef-local');
  assert.equal(state.settings.aiPolicy.secondaryId, 'gemma-local');
  assert.equal(state.settings.aiPolicy.version, 5);
  assert.ok(state.modelPolicies.some(p => p.version === 4));
  assert.equal(state.evaluations.length, 10);
  assert.equal(state.operationalRefs.length, 5);
  assert.ok(state.evaluations.every(e => e.provider === 'gateway' && !e.usedFallback));
  assert.ok(state.tasks.every(t => t.fallback === null));
  assert.equal(state.jobs[0].concurrency, 1);
  assert.deepEqual([...new Set(calls.filter(c => c.id !== 'pulso-local-connectivity-synthetic').map(c => c.id))], manifest.conversations.map(c => c.id));
  const before = calls.length;
  await assert.rejects(executeLocalPilot(store, registry, manifest, { maintenanceId: 'reset-synthetic' }), { code: 'LOCAL_RESET_REQUIRED' });
  assert.equal(calls.length, before);
});

test('partial local pilot retains maintenance; only matching maintenance can resume pending model tasks', async () => {
  const { state, registry, store, plan, reset, calls, control } = fixture();
  const manifest = await plan(); reset(); control.partial = true;
  const partial = await executeLocalPilot(store, registry, manifest, { maintenanceId: 'reset-synthetic' });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.completed, 5);
  assert.equal(partial.maintenanceReleased, false);
  assert.equal(state.settings.evaluationMaintenance, 'reset-synthetic');
  assert.equal(state.settings.dailyEnabled, false);
  const clefCalls = calls.filter(c => c.name === 'clef').length;
  state.settings.evaluationMaintenance = 'another-maintenance';
  await assert.rejects(resumeEvaluationBatch(store, registry, partial.jobId), { code: 'EVALUATION_MAINTENANCE' });
  state.settings.evaluationMaintenance = 'reset-synthetic';
  control.partial = false;
  const final = await executeLocalPilot(store, registry, manifest, { maintenanceId: 'reset-synthetic', resume: true });
  assert.equal(final.completed, 10);
  assert.equal(final.maintenanceReleased, true);
  assert.equal(calls.filter(c => c.name === 'clef').length, clefCalls);
  assert.equal(state.settings.dailyEnabled, false);
});

test('preflight and plan use saved tool/model configuration instead of disabled environment defaults', async () => {
  const { state, registry, calls, control } = savedConfigurationFixture();
  const preflight = await preflightLocalModels(registry, state);
  const manifest = createLocalPilotPlan(state, registry, preflight);
  assert.deepEqual(manifest.profiles.map(profile => profile.model), ['saved-clef-synthetic', 'saved-gemma-synthetic']);
  assert.ok(preflight.checks.every(check => check.configurationHash));
  assert.equal(calls.length, 2);
  assert.equal(control.mutations, 0);
  state.settings.localModelConfiguration.profiles[0].toolKey = 'another-tool-same-model';
  state.settings.localModelConfiguration.version++;
  assert.throws(() => createLocalPilotPlan(state, registry, preflight), { code: 'LOCAL_PREFLIGHT_REQUIRED' });
  assert.equal(calls.length, 2);
  state.settings.localModelConfiguration.profiles[0].enabled = false;
  await assert.rejects(preflightLocalModels(registry, state), { code: 'LOCAL_MODELS_REQUIRED' });
});

test('apply rejects a persisted configuration change after planning before any evaluation or write', async () => {
  const { state, registry, store, plan, reset, calls, control } = savedConfigurationFixture();
  const manifest = await plan(); reset();
  state.settings.localModelConfiguration.profiles[0].model = 'changed-clef-model';
  state.settings.localModelConfiguration.version++;
  await assert.rejects(executeLocalPilot(store, registry, manifest, { maintenanceId: 'reset-synthetic' }), { code: 'MODEL_CHANGED' });
  assert.equal(calls.length, 2);
  assert.equal(control.mutations, 0);
});

test('apply evaluates with saved local models and keeps the scheduler paused', async () => {
  const { state, registry, store, plan, reset } = savedConfigurationFixture();
  const manifest = await plan(); reset();
  const summary = await executeLocalPilot(store, registry, manifest, { maintenanceId: 'reset-synthetic' });
  assert.equal(summary.completed, 10);
  assert.equal(state.settings.dailyEnabled, false);
  assert.deepEqual([...new Set(state.evaluations.map(e => e.model))], ['saved-clef-synthetic', 'saved-gemma-synthetic']);
  assert.ok(state.evaluations.every(e => e.modelConfiguration.configurationHash === manifest.profiles.find(p => p.id === e.profileId).configurationHash));
});
