import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { inspectGemmaRenewal, prepareGemmaRenewal } from '../src/gemma-renewal-preparation.js';

function fixture() {
  const state = createState(false);
  state.settings = { ...state.settings, dailyEnabled: true, evaluationMaintenance: null,
    aiPolicy: { mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local', fallbackId: null, version: 5 },
    localModelConfiguration: { version: 2, profiles: [{ id: 'gemma-local', model: 'saved-gemma', toolKey: 'saved-tool', enabled: true }] } };
  state.evaluations = [{ id: 'existing-result', privateContent: 'SYNTHETIC_PRIVATE_EVIDENCE' }];
  state.reviews = [{ id: 'existing-review' }];
  const control = { writes: 0, calls: 0 };
  const registry = new ModelRegistry([{ id: 'gemma-local', provider: 'gateway', label: 'Gemma', model: 'saved-gemma', enabled: true,
    evaluator: { configured: true, baseUrl: 'http://synthetic-private-host.invalid', toolKey: 'saved-tool',
      evaluate() { control.calls++; assert.fail('Preparation must not call AI'); } } }]);
  const store = { async read() { return structuredClone(state); }, async transaction(fn) {
    const draft = structuredClone(state), result = await fn(draft); Object.assign(state, draft); control.writes++; return result;
  } };
  return { state, registry, store, control };
}

test('default inspection returns only configuration metadata and counts without writes or inference', async () => {
  const { state, registry, store, control } = fixture(), before = structuredClone(state);
  const result = inspectGemmaRenewal(await store.read(), registry);
  assert.equal(result.readOnly, true); assert.equal(result.policy.version, 5); assert.equal(result.counts.evaluations, 1);
  assert.equal(control.writes, 0); assert.equal(control.calls, 0); assert.deepEqual(state, before);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|synthetic-private-host/);
});

test('prepare versions single Gemma policy, pauses daily and preserves profiles, results, reviews and catalog', async () => {
  const { state, registry, store, control } = fixture(), before = structuredClone(state);
  const result = await prepareGemmaRenewal(store, registry, { expectedPolicyVersion: 5, now: () => '2026-11-06T22:00:00.000Z' });
  assert.equal(result.changed, true); assert.equal(state.settings.aiPolicy.version, 6);
  assert.deepEqual([state.settings.aiPolicy.mode, state.settings.aiPolicy.primaryId, state.settings.aiPolicy.secondaryId, state.settings.aiPolicy.fallbackId], ['single', 'gemma-local', null, null]);
  assert.equal(state.settings.dailyEnabled, false); assert.equal(state.settings.evaluationMaintenance, null);
  assert.deepEqual(state.modelPolicies.map(p => p.version), [5, 6]);
  for (const key of ['evaluations', 'reviews', 'catalog', 'users']) assert.deepEqual(state[key], before[key]);
  assert.deepEqual(state.settings.localModelConfiguration, before.settings.localModelConfiguration); assert.equal(control.calls, 0);
  const again = await prepareGemmaRenewal(store, registry, { expectedPolicyVersion: 6 });
  assert.equal(again.changed, false); assert.equal(state.modelPolicies.length, 2);
});

test('version conflicts, active jobs, maintenance and unavailable Gemma cannot change settings', async () => {
  for (const [change, version, code] of [
    [() => {}, 4, 'VERSION_CONFLICT'],
    [s => { s.jobs = [{ status: 'running' }]; }, 5, 'EVALUATION_RUNNING'],
    [s => { s.jobs = [{ status: 'pending' }]; }, 5, 'EVALUATION_RUNNING'],
    [s => { s.jobs = [{ status: 'queued' }]; }, 5, 'EVALUATION_RUNNING'],
    [s => { s.settings.evaluationMaintenance = 'existing-maintenance'; }, 5, 'EVALUATION_MAINTENANCE'],
  ]) {
    const { state, registry, store, control } = fixture(); change(state); const before = structuredClone(state);
    await assert.rejects(prepareGemmaRenewal(store, registry, { expectedPolicyVersion: version }), { code });
    assert.deepEqual(state, before); assert.equal(control.writes, 0); assert.equal(control.calls, 0);
  }
  const { state, registry, store, control } = fixture(); registry.profiles[0].enabled = false;
  assert.equal(inspectGemmaRenewal(state, registry).configurationError, 'AI_CONFIGURATION');
  await assert.rejects(prepareGemmaRenewal(store, registry, { expectedPolicyVersion: 5 }), { code: 'AI_CONFIGURATION' });
  assert.equal(control.writes, 0); assert.equal(control.calls, 0);
});
