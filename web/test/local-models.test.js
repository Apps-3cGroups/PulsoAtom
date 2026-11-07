import test from 'node:test';
import assert from 'node:assert/strict';
import { executableProfiles, localConfigurationMatches, onlyDisablingLocalProfiles, policySelection, saveLocalConfiguration } from '../src/services/localModels.js';

const profiles = [
  { id: 'clef-local', toolKey: 'clef-tool', model: 'clef-published', enabled: true, responseFormat: 'json_schema' },
  { id: 'gemma-local', toolKey: 'gemma-tool', model: 'gemma-published', enabled: true, responseFormat: 'json_object' },
];
const saved = { version: 2, gatewayConfigured: true, policyReady: true, profiles };

test('only deactivation can be saved without Gateway credentials; changed models and activations still need discovery', () => {
  assert.equal(onlyDisablingLocalProfiles(profiles, profiles), false);
  const disabled = profiles.map(p => ({ ...p, enabled: false }));
  assert.equal(onlyDisablingLocalProfiles(profiles, disabled), true);
  assert.equal(onlyDisablingLocalProfiles(disabled, profiles), false);
  assert.equal(onlyDisablingLocalProfiles(profiles, disabled.map(p => ({ ...p, model: 'changed' }))), false);
});

test('real execution choices exclude public and historical profiles but retain demo choices', () => {
  const registry = [...profiles.map(profile => ({ ...profile, provider: 'gateway', available: true })),
    { id: 'openai-default', provider: 'openai', available: true },
    { id: 'gemini-default', provider: 'gemini', available: true },
    { id: 'past-clef', provider: 'gateway', historical: true, available: false }];
  assert.deepEqual(executableProfiles(registry).map(p => p.id), ['clef-local', 'gemma-local']);
  assert.equal(executableProfiles(registry, true).length, 4);
  assert.deepEqual(policySelection({ mode: 'dual', primaryId: 'openai-default', secondaryId: 'gemini-default' }, executableProfiles(registry)), {
    mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local', fallbackId: null, pending: true,
  });
  assert.equal(policySelection({ mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local' }, executableProfiles(registry)).pending, false);
  assert.equal(policySelection({ primaryId: 'openai-default' }, []).primaryId, undefined);
});

test('saving confirms the persisted configuration and sends no labels or connection secrets', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return Response.json(saved); });
  assert.deepEqual(await saveLocalConfiguration(profiles, 1), saved);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/pulsoAtom/api/models/local-configuration');
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].options.body), { profiles, expectedVersion: 1 });
});

test('a lost save response is confirmed with GET without repeating the write', async t => {
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    methods.push(options.method);
    if (options.method === 'PUT') throw new Error('lost connection after commit');
    return Response.json(saved);
  });
  assert.deepEqual(await saveLocalConfiguration(profiles, 1), saved);
  assert.deepEqual(methods, ['PUT', 'GET']);
});

test('a version conflict is preserved for explicit reload without silently overwriting the draft', async t => {
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    methods.push(options.method);
    return Response.json({ error: { message: 'La configuración cambió.', code: 'VERSION_CONFLICT' } }, { status: 409 });
  });
  await assert.rejects(saveLocalConfiguration(profiles, 1), error => error.code === 'VERSION_CONFLICT');
  assert.deepEqual(methods, ['PUT']);
});

test('unconfirmed writes never return success for old, different or malformed configuration', async t => {
  for (const result of [{ ...saved, version: 1 }, { ...saved, profiles: [profiles[0], { ...profiles[1], enabled: false }] }, { version: 2 }]) {
    assert.equal(localConfigurationMatches(result, profiles, 1), false);
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(result));
    await assert.rejects(saveLocalConfiguration(profiles, 1), error => error.code === 'LOCAL_SAVE_UNCONFIRMED');
    mock.mock.restore();
  }
});

test('changing the protocol is a model edit and must be confirmed in the saved snapshot', () => {
  const native = profiles.map(p => ({ ...p, protocol: p.id === 'clef-local' ? 'systemone' : 'chat' }));
  assert.equal(onlyDisablingLocalProfiles(profiles, native.map(p => ({ ...p, enabled: false }))), false);
  assert.equal(localConfigurationMatches(saved, native, 1), false);
  assert.equal(localConfigurationMatches({ ...saved, profiles: native }, native, 1), true);
  assert.equal(localConfigurationMatches({ ...saved, profiles: profiles.map(p => ({ ...p, protocol: 'chat' })) }, profiles, 1), true);
});
