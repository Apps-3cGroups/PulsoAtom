import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registryFromEnv, asRegistry, ModelRegistry } from '../src/model-registry.js';
import { OpenAIEvaluator } from '../src/evaluator.js';
import { digest } from '../src/evaluation-context.js';
import { integrationStatus } from '../src/app.js';

const specs = [
  { id: 'clef-local', label: 'Clef', provider: 'gateway', envPrefix: 'CLEF' },
  { id: 'gemma-local', label: 'Gemma', provider: 'gateway', envPrefix: 'GEMMA' },
];
const environment = overrides => ({ AI_MODEL_PROFILES: JSON.stringify(specs), GATEWAY_BASE_URL: 'http://gateway.example:9000',
  AGENT_SHARED_TOKEN: 'synthetic-private-token', GATEWAY_PORTAL_KEY: 'pulso-test',
  CLEF_TOOL_KEY: 'clef', CLEF_MODEL: 'clef-synthetic', CLEF_EVALUATION_ENABLED: 'true',
  GEMMA_TOOL_KEY: 'gemma', GEMMA_MODEL: 'gemma-synthetic', GEMMA_EVALUATION_ENABLED: 'true', ...overrides });
const offline = () => { throw new Error('Registry construction must not call a model'); };
const registry = overrides => registryFromEnv({ env: environment(overrides), fetchImpl: offline });

test('explicit local registry contains only Clef/Gemma even when old public credentials remain in the environment', () => {
  const models = registry({ OPENAI_API_KEY: 'synthetic-public-secret', OPENAI_MODEL: 'old-public-model', OPENAI_EVALUATION_ENABLED: 'true', GEMINI_API_KEY: 'synthetic-other-secret', GEMINI_MODEL: 'old-other-model', GEMINI_EVALUATION_ENABLED: 'true' });
  assert.deepEqual(models.list().map(p => [p.id, p.label, p.model, p.provider, p.available]), [
    ['clef-local', 'Clef', 'clef-synthetic', 'gateway', true], ['gemma-local', 'Gemma', 'gemma-synthetic', 'gateway', true],
  ]);
  for (const id of ['openai-default', 'gemini-default']) assert.throws(() => models.resolve(id), { code: 'AI_CONFIGURATION' });
  assert.doesNotMatch(JSON.stringify(models.list()), /synthetic-private-token|synthetic-public-secret|gateway\.example|baseUrl|portalKey|token|envPrefix/);
  assert.doesNotMatch(JSON.stringify(models.profiles), /synthetic-private-token/);
});

test('missing credentials, tool, portal identity, model or invalid generation settings leave local profiles unavailable', () => {
  for (const overrides of [{ AGENT_SHARED_TOKEN: '' }, { GATEWAY_BASE_URL: '' }, { GATEWAY_PORTAL_KEY: '' }, { CLEF_TOOL_KEY: '' }, { CLEF_MODEL: '' }, { CLEF_TIMEOUT_MS: 'NaN' }, { CLEF_MAX_TOKENS: '-1' }, { CLEF_RESPONSE_FORMAT: 'automatic' }]) {
    const models = registry(overrides);
    assert.equal(models.list()[0].available, false, JSON.stringify(Object.keys(overrides)));
    assert.throws(() => models.resolve('clef-local'), { code: 'AI_CONFIGURATION' });
  }
  assert.equal(registry({ CLEF_EVALUATION_ENABLED: 'false' }).list()[0].available, false);
});

test('gateway profile identity includes inference configuration but excludes credential rotation', () => {
  const base = registry().list()[0];
  assert.equal(registry({ AGENT_SHARED_TOKEN: 'rotated-synthetic-secret' }).list()[0].configurationHash, base.configurationHash);
  for (const overrides of [{ GATEWAY_BASE_URL: 'https://other-gateway.example' }, { GATEWAY_PORTAL_KEY: 'another-portal' }, { CLEF_TOOL_KEY: 'other-tool' }, { CLEF_MODEL: 'different-model' }, { CLEF_MAX_TOKENS: '8000' }, { CLEF_TEMPERATURE: '0.2' }, { CLEF_RESPONSE_FORMAT: 'json_object' }, { CLEF_TIMEOUT_MS: '90000' }]) {
    const changed = registry(overrides);
    assert.notEqual(changed.list()[0].configurationHash, base.configurationHash);
    assert.throws(() => changed.resolve('clef-local', base), { code: 'MODEL_CHANGED' });
  }
});

test('local profiles default to the confirmed portal identity when no environment override exists', () => {
  const models = registry({ GATEWAY_PORTAL_KEY: undefined });
  assert.equal(models.resolve('clef-local').evaluator.portalKey, 'portal-pulso');
  assert.equal(models.resolve('gemma-local').evaluator.portalKey, 'portal-pulso');
});

test('Clef Flash output contract is versioned without changing the Gemma configuration hash', () => {
  const models = registry({ CLEF_MODEL: 'clef-flash' });
  const [clef, gemma] = models.list();
  assert.equal(clef.outputSchemaVersion, 'clef-flash-schema-1');
  assert.equal(clef.configurationHash, digest(['gateway', 'clef-flash', 'http://gateway.example:9000', 180000,
    { toolKey: 'clef', portalKey: 'pulso-test', responseFormat: 'json_schema', maxTokens: 16000, temperature: 0,
      outputSchemaVersion: 'clef-flash-schema-1' }]));
  const previous = { ...clef, configurationHash: digest(['gateway', 'clef-flash', 'http://gateway.example:9000', 180000,
    { toolKey: 'clef', portalKey: 'pulso-test', responseFormat: 'json_schema', maxTokens: 16000, temperature: 0 }]) };
  assert.throws(() => models.resolve('clef-local', previous), { code: 'MODEL_CHANGED' });
  assert.equal(gemma.configurationHash, registry().list()[1].configurationHash);
  assert.ok(!Object.hasOwn(gemma, 'outputSchemaVersion'));
});

test('existing OpenAI/Gemini configuration hashes stay compatible', () => {
  const models = new ModelRegistry([{ id: 'historical', provider: 'openai', model: 'legacy-exact', enabled: true,
    evaluator: new OpenAIEvaluator({ apiKey: 'synthetic', baseUrl: 'https://api.openai.com/v1', model: 'legacy-exact', timeoutMs: 120000, fetchImpl: offline }) }]);
  assert.equal(models.list()[0].configurationHash, digest(['openai', 'legacy-exact', 'https://api.openai.com/v1', 120000]));
  assert.equal(models.list()[0].available, true);
});

test('default installation exposes only local slots even with a legacy public registry and enabled keys', () => {
  const cloud = { OPENAI_MODEL: 'old-public', OPENAI_API_KEY: 'unused', OPENAI_EVALUATION_ENABLED: 'true',
    GEMINI_MODEL: 'old-other', GEMINI_API_KEY: 'unused-other', GEMINI_EVALUATION_ENABLED: 'true' };
  for (const extra of [{}, { AI_MODEL_PROFILES: JSON.stringify([
    { id: 'openai-default', label: 'Luna', provider: 'openai', model: 'old-public', envPrefix: 'OPENAI' },
    { id: 'gemini-default', label: 'Gemini', provider: 'gemini', envPrefix: 'GEMINI' },
  ]) }]) {
    const models = registryFromEnv({ env: { ...cloud, ...extra }, fetchImpl: offline });
    assert.deepEqual(models.list().map(p => [p.id, p.label, p.provider, p.available]), [
      ['clef-local', 'Clef', 'gateway', false], ['gemma-local', 'Gemma', 'gateway', false],
    ]);
    assert.equal(models.configured, false);
    assert.throws(() => models.resolve('openai-default'), { code: 'AI_CONFIGURATION' });
    assert.throws(() => models.resolve('gemini-default'), { code: 'AI_CONFIGURATION' });
  }
});

test('saved local profile settings bind without mutating old evaluators or exposing backend credentials', () => {
  const models = registry({ AI_MODEL_PROFILES: undefined, CLEF_MODEL: '', GEMMA_MODEL: '', CLEF_EVALUATION_ENABLED: 'false', GEMMA_EVALUATION_ENABLED: 'false' });
  const state = { settings: { localModelConfiguration: { version: 3, profiles: [
    { id: 'clef-local', toolKey: 'clef-tool', model: 'clef-saved', responseFormat: 'json_object', enabled: true },
    { id: 'gemma-local', toolKey: 'gemma-tool', model: 'gemma-saved', responseFormat: 'json_schema', enabled: true },
  ] }, aiPolicy: { mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local', version: 2 } } };
  const bound = models.forState(state);
  assert.equal(models.configured, false);
  assert.equal(bound.resolve('clef-local').model, 'clef-saved');
  const oldSnapshot = bound.list()[0];
  const safe = models.localConfiguration(state);
  assert.equal(safe.gatewayConfigured, true);
  assert.equal(safe.policyReady, true);
  assert.equal(safe.version, 3);
  assert.doesNotMatch(JSON.stringify(safe), /synthetic-private-token|gateway\.example|baseUrl|portalKey/);
  state.settings.localModelConfiguration.profiles[0].model = 'changed';
  assert.equal(bound.resolve('clef-local').model, 'clef-saved');
  assert.throws(() => models.forState(state).resolve('clef-local', oldSnapshot), { code: 'MODEL_CHANGED' });
  state.settings.localModelConfiguration.profiles[0].enabled = false;
  assert.equal(models.localConfiguration(state).policyReady, false);
});

test('a standalone Gateway adapter is never attributed to OpenAI by the compatibility wrapper', () => {
  const local = asRegistry(registry().resolve('clef-local').evaluator);
  assert.equal(local.list()[0].provider, 'gateway');
  assert.equal(local.list()[0].model, 'clef-synthetic');
});

test('readiness is provider-neutral and never requires public provider credentials for local evaluation', () => {
  const env = { APP_DB_HOST: 'test-db', ATOM_DB_HOST: 'test-atom', ATOM_DB_NAME: 'test', ATOM_CONVERSATIONS_TABLE: 'conversations', ATOM_MESSAGES_TABLE: 'messages', ATOM_COUNTRIES_TABLE: 'countries' };
  const ready = integrationStatus(registry(), env);
  assert.equal(ready.ready, true); assert.equal(ready.aiConfigured, true); assert.deepEqual(ready.blockers, []);
  const pending = integrationStatus(registry({ AGENT_SHARED_TOKEN: '' }), env);
  assert.equal(pending.ready, false);
  assert.doesNotMatch(JSON.stringify(pending), /OpenAI|Gemini|GPT|token|secret/);
});

test('native decisions are explicit and do not change Gemma or legacy chat identity', () => {
  const chat = registry().list();
  const native = registry({ CLEF_PROTOCOL: 'systemone' });
  const clef = native.list()[0];
  assert.equal(clef.protocol, 'systemone');
  assert.equal(clef.explanationType, 'typed_decision');
  assert.ok(clef.adapterVersion);
  assert.notEqual(clef.configurationHash, chat[0].configurationHash);
  assert.equal(native.list()[1].configurationHash, chat[1].configurationHash);
  assert.equal(native.list()[1].configurationHash, digest(['gateway', 'gemma-synthetic', 'http://gateway.example:9000', 180000,
    { toolKey: 'gemma', portalKey: 'pulso-test', responseFormat: 'json_schema', maxTokens: 16000, temperature: 0 }]));
  assert.equal(registry({ CLEF_PROTOCOL: 'chat' }).list()[0].configurationHash, chat[0].configurationHash);
  assert.equal(native.resolve('clef-local').evaluator.protocol, 'systemone');
  assert.equal(asRegistry(native.resolve('clef-local').evaluator).list()[0].provider, 'gateway');
  assert.throws(() => native.resolve('clef-local', chat[0]), { code: 'MODEL_CHANGED' });
});

test('invalid native protocol configuration cannot silently call a chat endpoint', () => {
  assert.equal(registry({ CLEF_PROTOCOL: 'auto' }).list()[0].available, false);
  assert.equal(registry({ GEMMA_PROTOCOL: 'systemone' }).list()[1].available, false);
  const state = { settings: { localModelConfiguration: { profiles: [
    { id: 'clef-local', toolKey: 'saved-tool', model: 'saved-decision', enabled: true, protocol: 'systemone', responseFormat: 'json_schema' },
  ] } } };
  const bound = registry().forState(state);
  assert.equal(bound.resolve('clef-local').evaluator.protocol, 'systemone');
  assert.equal(bound.localConfiguration(state).profiles[0].explanationType, 'typed_decision');
});


test('an existing saved chat profile is not reinterpreted by a newly added environment protocol', () => {
  const state = { settings: { localModelConfiguration: { profiles: [
    { id: 'clef-local', toolKey: 'clef', model: 'clef-synthetic', enabled: true, responseFormat: 'json_schema' },
  ] } } };
  const bound = registry({ CLEF_PROTOCOL: 'systemone' }).forState(state);
  assert.equal(bound.list()[0].protocol, 'chat');
  assert.equal(bound.list()[0].configurationHash, registry().list()[0].configurationHash);
});
