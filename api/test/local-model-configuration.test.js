import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createState } from '../src/data/seed.js';
import { registryFromEnv } from '../src/model-registry.js';
import { newToken, tokenHash } from '../src/auth.js';

const prefix = '/pulsoAtom/api';
const env = { GATEWAY_BASE_URL: 'http://gateway.synthetic:9000', AGENT_SHARED_TOKEN: 'secret-synthetic-local-gateway', GATEWAY_PORTAL_KEY: 'portal-pulso' };
const profiles = [
  { id: 'clef-local', toolKey: 'clef-tool', model: 'clef-synthetic-exact', enabled: true, responseFormat: 'json_schema' },
  { id: 'gemma-local', toolKey: 'gemma-tool', model: 'gemma-synthetic-exact', enabled: true, responseFormat: 'json_object' },
];
const input = () => ({ expectedVersion: 1, profiles: structuredClone(profiles) });
function fixture({ demo = false, environment = env } = {}) {
  const state = createState(false);
  state.settings = { ...state.settings, dailyEnabled: true, version: 7,
    aiPolicy: { mode: 'single', primaryId: 'openai-default', secondaryId: null, fallbackId: null, version: 4 } };
  const tokens = Object.fromEntries(['admin', 'supervisor'].map(role => [role, newToken()]));
  state.users = Object.keys(tokens).map(role => ({ id: role, name: `Usuario ${role}`, role, active: true }));
  state.sessions = Object.entries(tokens).map(([role, token]) => ({ id: tokenHash(token), userId: role, expiresAt: new Date(Date.now() + 60000).toISOString() }));
  const controls = { calls: [], writes: 0, failed: false, toolStatus: 'active', onFetch: null, persistFailure: false, invalidCatalog: null };
  const fetchImpl = async (url, options) => {
    controls.calls.push([url, options]);
    await controls.onFetch?.(url, options);
    if (controls.failed) return { ok: false, status: 503, async json() { assert.fail('Error bodies must never be exposed'); } };
    const body = options.body && JSON.parse(options.body);
    const tool = body ? url.includes('/clef-tool/') ? 'clef-tool' : 'gemma-tool' : null;
    const data = !body ? controls.invalidCatalog || { tools: profiles.map(p => ({ key: p.toolKey, status: controls.toolStatus,
      base_url: 'http://private-provider:1234', token: env.AGENT_SHARED_TOKEN,
      ...(controls.nativeCapabilities ? { paths: [{ method: 'GET', path: '/v1/models' }, { method: 'POST', path: '/v1/chat/completions' }, { method: 'POST', path: '/v1/systemone' }, { method: 'GET', path: '/api/v1/models' }] } : {}) })) }
      : { ok: true, tool_key: tool, request_uuid: `gateway-request-${controls.calls.length}`, method: 'GET', path: body.path, upstream_status_code: 200,
        response: body.path === '/api/v1/models' ? { models: [{ type: controls.nativeType || 'decision', key: 'cloudflare/clef',
          loaded_instances: [{ id: profiles.find(p => p.toolKey === tool).model, config: { context_length: 8192 } }] }] }
          : { data: [{ id: profiles.find(p => p.toolKey === tool).model, privatePath: '/private/model/files' }] } };
    return { ok: true, status: 200, async json() { return data; } };
  };
  const store = {
    async read() { return structuredClone(state); },
    async readWithConversations() { return structuredClone(state); },
    async transaction(fn) {
      const draft = structuredClone(state); const result = await fn(draft);
      if (controls.persistFailure) throw new Error('private persistence error');
      controls.writes++; Object.assign(state, draft); return structuredClone(result);
    },
  };
  const registry = registryFromEnv({ env: environment, fetchImpl });
  const config = { demo, basePath: '/pulsoAtom', origin: 'http://127.0.0.1:3000', timezone: 'America/Tegucigalpa', sessionHours: 8, secureCookie: false };
  const app = createApp(store, config, registry, null, {}, { gatewayEnv: environment, gatewayFetchImpl: fetchImpl });
  const call = (method, route, body, role = 'admin') => {
    let operation = request(app)[method](prefix + route);
    if (role) operation = operation.set('Cookie', `pulso_session=${tokens[role]}`);
    if (body !== undefined) operation = operation.send(body);
    return operation;
  };
  return { app, call, state, store, registry, controls };
}

test('all local model endpoints require authentication and administration before any Gateway request', async () => {
  const { call, controls } = fixture();
  for (const [method, route, body] of [['get', '/models/local-configuration'], ['get', '/models/gateway/tools'],
    ['get', '/models/gateway/tools/clef-tool/models'], ['put', '/models/local-configuration', input()]]) {
    await call(method, route, body, null).expect(401);
    await call(method, route, body, 'supervisor').expect(403);
  }
  assert.equal(controls.calls.length, 0);
  assert.equal(controls.writes, 0);
});

test('configuration reads return only safe Clef/Gemma settings and do not query upstream', async () => {
  const { call, controls } = fixture();
  const { body, headers } = await call('get', '/models/local-configuration').expect(200);
  assert.equal(body.version, 1);
  assert.equal(body.gatewayConfigured, true);
  assert.equal(body.policyReady, false);
  assert.deepEqual(body.profiles.map(p => [p.id, p.label]), [['clef-local', 'Clef'], ['gemma-local', 'Gemma']]);
  assert.ok(body.profiles.every(p => !p.enabled && p.model === '' && p.toolKey === ''));
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(controls.calls.length, 0);
  assert.equal(controls.writes, 0);
  assert.doesNotMatch(JSON.stringify(body), /secret-synthetic|gateway\.synthetic|private-provider/);
  const unavailable = fixture({ environment: {} });
  assert.equal((await unavailable.call('get', '/models/local-configuration').expect(200)).body.gatewayConfigured, false);
});

test('two enabled local slots pointing to one model cannot report a ready dual policy', async () => {
  const environment = { ...env, CLEF_MODEL: 'same-effective-model', GEMMA_MODEL: 'same-effective-model',
    CLEF_TOOL_KEY: 'clef-tool', GEMMA_TOOL_KEY: 'gemma-tool', CLEF_EVALUATION_ENABLED: 'true', GEMMA_EVALUATION_ENABLED: 'true' };
  const { call, state, controls } = fixture({ environment });
  state.settings.aiPolicy = { mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local', fallbackId: null, version: 4 };
  assert.equal((await call('get', '/models/local-configuration').expect(200)).body.policyReady, false);
  assert.equal((await call('get', '/health').expect(200)).body.evaluationReady, false);
  assert.equal(controls.calls.length, 0);
  assert.equal(controls.writes, 0);
});

test('admin discovery exposes keys, status and model IDs while keeping URLs and credentials server-side', async () => {
  const { call, controls } = fixture();
  const tools = await call('get', '/models/gateway/tools').expect(200);
  assert.deepEqual(tools.body, { tools: [{ key: 'clef-tool', status: 'active' }, { key: 'gemma-tool', status: 'active' }] });
  const models = await call('get', '/models/gateway/tools/clef-tool/models').expect(200);
  assert.deepEqual(models.body, { tool: 'clef-tool', models: ['clef-synthetic-exact'], request_uuid: 'gateway-request-3' });
  assert.ok(controls.calls.every(([url]) => url.startsWith(env.GATEWAY_BASE_URL + '/v1/tools')));
  assert.ok(controls.calls.filter(([, options]) => options.body).every(([, options]) => JSON.parse(options.body).method === 'GET'));
  assert.equal(controls.writes, 0);
  const before = controls.calls.length;
  await call('get', '/models/gateway/tools/invalid.key/models').expect(422);
  await call('get', '/models/gateway/tools?token=not-accepted').expect(422);
  assert.equal(controls.calls.length, before);
});

test('saving validates both live models then atomically versions configuration/policy and pauses daily execution', async () => {
  const { call, state, registry, controls } = fixture();
  const preserved = structuredClone({ evaluations: state.evaluations, reviews: state.reviews, catalog: state.catalog });
  const result = await call('put', '/models/local-configuration', input()).expect(200);
  assert.equal(result.body.version, 2);
  assert.equal(result.body.policyReady, true);
  assert.equal(result.body.gatewayConfigured, true);
  assert.deepEqual(result.body.profiles, profiles.map(p => ({ ...p, label: p.id === 'clef-local' ? 'Clef' : 'Gemma', protocol: 'chat', explanationType: 'model_text' })));
  assert.equal(state.settings.dailyEnabled, false);
  assert.equal(state.settings.version, 8);
  assert.equal(state.settings.aiPolicy.version, 5);
  assert.equal(state.settings.aiPolicy.mode, 'dual');
  assert.equal(state.settings.aiPolicy.primaryId, 'clef-local');
  assert.equal(state.settings.aiPolicy.secondaryId, 'gemma-local');
  assert.equal(state.settings.aiPolicy.fallbackId, null);
  assert.deepEqual(state.settings.localModelConfigurationHistory.map(c => c.version), [1, 2]);
  assert.equal(state.settings.localModelConfiguration.updatedById, 'admin');
  assert.equal(state.settings.localModelConfiguration.validation.length, 2);
  assert.equal(state.modelPolicies.length, 2);
  assert.equal(controls.writes, 1);
  assert.equal(controls.calls.length, 3);
  assert.deepEqual({ evaluations: state.evaluations, reviews: state.reviews, catalog: state.catalog }, preserved);
  assert.equal(registry.forState(state).resolve('gemma-local').model, 'gemma-synthetic-exact');
  assert.deepEqual((await call('get', '/models/local-configuration').expect(200)).body, result.body);
  const listed = (await call('get', '/models').expect(200)).body.profiles.filter(p => !p.historical);
  assert.deepEqual(listed.map(p => [p.id, p.model]), profiles.map(p => [p.id, p.model]));
  assert.ok(!JSON.stringify(state).includes(env.AGENT_SHARED_TOKEN));
  assert.ok(controls.calls.filter(([, options]) => options.body).every(([, options]) => JSON.parse(options.body).path === '/v1/models'));
});

test('duplicate identities, malformed fields and unavailable tools/models cannot be persisted', async () => {
  const { call, state, controls } = fixture();
  for (const change of [body => { body.profiles[1].model = body.profiles[0].model; },
    body => { body.profiles[1].id = body.profiles[0].id; }, body => { body.profiles[0].model = ''; },
    body => { body.profiles[0].token = 'not-accepted'; }, body => { body.profiles[0].model = 'http://private-provider/model'; },
    body => { body.profiles[0].responseFormat = 'off'; }, body => { body.profiles[0].id = 'openai-default'; }]) {
    const body = input(); change(body);
    await call('put', '/models/local-configuration', body).expect(422);
  }
  assert.equal(controls.calls.length, 0);
  controls.toolStatus = 'inactive';
  assert.equal((await call('put', '/models/local-configuration', input()).expect(409)).body.error.code, 'TOOL_UNAVAILABLE');
  controls.toolStatus = 'active';
  const missing = input(); missing.profiles[1].model = 'missing-model';
  assert.equal((await call('put', '/models/local-configuration', missing).expect(409)).body.error.code, 'MODEL_UNAVAILABLE');
  assert.equal(controls.writes, 0);
  assert.equal(state.settings.localModelConfiguration, undefined);
  assert.equal(state.settings.dailyEnabled, true);
});

test('version conflicts, running/queued jobs and maintenance block save before discovery and again before commit', async () => {
  for (const [setup, error] of [
    [state => { state.settings.localModelConfiguration = { version: 2, profiles }; }, 'VERSION_CONFLICT'],
    [state => { state.jobs.push({ id: 'running', status: 'running' }); }, 'EVALUATION_RUNNING'],
    [state => { state.jobs.push({ id: 'queued', status: 'queued' }); }, 'EVALUATION_RUNNING'],
    [state => { state.settings.evaluationMaintenance = 'maintenance'; }, 'EVALUATION_MAINTENANCE'],
  ]) {
    const { call, state, controls } = fixture(); setup(state);
    assert.equal((await call('put', '/models/local-configuration', input()).expect(409)).body.error.code, error);
    assert.equal(controls.calls.length, 0);
    assert.equal(controls.writes, 0);
  }
  const concurrent = fixture();
  concurrent.controls.onFetch = url => { if (url.includes('/gemma-tool/')) concurrent.state.jobs.push({ id: 'concurrent', status: 'running' }); };
  assert.equal((await concurrent.call('put', '/models/local-configuration', input()).expect(409)).body.error.code, 'EVALUATION_RUNNING');
  assert.equal(concurrent.state.settings.localModelConfiguration, undefined);
  assert.equal(concurrent.controls.writes, 0);
});

test('pure deactivation works during an outage, while activation or editing still requires live validation', async () => {
  const { call, controls, state } = fixture();
  await call('put', '/models/local-configuration', input()).expect(200);
  controls.failed = true;
  const calls = controls.calls.length;
  const disabled = input(); disabled.expectedVersion = 2; disabled.profiles.forEach(p => { p.enabled = false; });
  const result = await call('put', '/models/local-configuration', disabled).expect(200);
  assert.equal(result.body.version, 3);
  assert.equal(result.body.policyReady, false);
  assert.equal(controls.calls.length, calls);
  assert.equal(state.settings.localModelConfiguration.validationMode, 'deactivation-only');
  const enable = input(); enable.expectedVersion = 3;
  assert.equal((await call('put', '/models/local-configuration', enable).expect(502)).body.error.code, 'AI_TRANSIENT');
  const edit = { ...disabled, expectedVersion: 3, profiles: structuredClone(disabled.profiles) }; edit.profiles[0].model = 'changed-model';
  await call('put', '/models/local-configuration', edit).expect(502);
  assert.equal(state.settings.localModelConfiguration.version, 3);
  assert.equal(controls.writes, 2);
});

test('demo discovery and configuration never contact a real Gateway or claim successful persistence', async () => {
  const { call, controls } = fixture({ demo: true });
  const configuration = (await call('get', '/models/local-configuration').expect(200)).body;
  assert.equal(configuration.gatewayConfigured, false);
  assert.equal(configuration.policyReady, false);
  for (const [method, route, body] of [['get', '/models/gateway/tools'], ['get', '/models/gateway/tools/clef-tool/models'],
    ['put', '/models/local-configuration', input()]]) {
    assert.equal((await call(method, route, body).expect(409)).body.error.code, 'DEMO_MODE');
  }
  assert.equal(controls.calls.length, 0);
  assert.equal(controls.writes, 0);
});

test('failed persistence is not reported as success and upstream errors never disclose secret payloads', async t => {
  t.mock.method(console, 'error', () => {});
  const { call, controls, state } = fixture();
  controls.persistFailure = true;
  const result = await call('put', '/models/local-configuration', input()).expect(500);
  assert.equal(result.body.error.code, 'INTERNAL_ERROR');
  assert.equal(result.body.version, undefined);
  assert.equal(state.settings.localModelConfiguration, undefined);
  assert.equal(state.settings.dailyEnabled, true);
  controls.invalidCatalog = { ok: false, tools: [], error: { token: env.AGENT_SHARED_TOKEN, url: env.GATEWAY_BASE_URL } };
  const upstream = await call('get', '/models/gateway/tools').expect(502);
  assert.equal(upstream.body.error.code, 'INVALID_GATEWAY_CATALOG');
  assert.ok(!JSON.stringify(upstream.body).includes(env.AGENT_SHARED_TOKEN));
  assert.ok(!JSON.stringify(upstream.body).includes(env.GATEWAY_BASE_URL));
});

test('native Clef configuration verifies advertised routes and loaded decision identity without inference', async () => {
  const { call, controls, state, registry } = fixture();
  controls.nativeCapabilities = true;
  const body = input(); body.profiles[0].protocol = 'systemone';
  const saved = (await call('put', '/models/local-configuration', body).expect(200)).body;
  assert.equal(saved.profiles[0].protocol, 'systemone');
  assert.equal(saved.profiles[0].explanationType, 'typed_decision');
  assert.equal(saved.profiles[1].protocol, 'chat');
  assert.equal(registry.forState(state).resolve('clef-local').evaluator.protocol, 'systemone');
  assert.equal(state.settings.localModelConfiguration.validation.filter(v => v.protocol === 'systemone').length, 1);
  assert.ok(controls.calls.filter(([, options]) => options.body).every(([, options]) => JSON.parse(options.body).method === 'GET'));
  assert.equal(controls.calls.filter(([, options]) => options.body && JSON.parse(options.body).path === '/api/v1/models').length, 1);
});

test('native Clef cannot be saved against chat-only routes or a chat-loaded model', async () => {
  for (const nativeCapabilities of [false, true]) {
    const { call, controls, state } = fixture(); controls.nativeCapabilities = nativeCapabilities; controls.nativeType = 'llm';
    const body = input(); body.profiles[0].protocol = 'systemone';
    assert.equal((await call('put', '/models/local-configuration', body).expect(409)).body.error.code, 'AI_CONFIGURATION');
    assert.equal(controls.writes, 0);
    assert.equal(state.settings.localModelConfiguration, undefined);
    assert.equal(state.settings.dailyEnabled, true);
  }
  const { call, controls } = fixture();
  const invalid = input(); invalid.profiles[1].protocol = 'systemone';
  await call('put', '/models/local-configuration', invalid).expect(422);
  assert.equal(controls.calls.length, 0);
});
