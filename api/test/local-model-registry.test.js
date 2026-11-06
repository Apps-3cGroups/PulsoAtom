import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registryFromEnv, asRegistry } from '../src/model-registry.js';
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

test('existing OpenAI/Gemini configuration hashes stay compatible', () => {
  const models = registryFromEnv({ env: { OPENAI_MODEL: 'legacy-exact', OPENAI_API_KEY: 'synthetic', OPENAI_EVALUATION_ENABLED: 'true' }, fetchImpl: offline });
  assert.equal(models.list()[0].configurationHash, digest(['openai', 'legacy-exact', 'https://api.openai.com/v1', 120000]));
  assert.equal(models.list()[0].available, true);
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
