import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { evaluationContext } from '../src/evaluation-context.js';
import { parseEvaluationResetArguments, assertGemmaResetPreconditions } from '../src/evaluation-reset-safety.js';

const hash = 'a'.repeat(64);
const guardArgs = ['--expected-policy-version', '6', '--expected-configuration-hash', hash, '--expected-catalog-hash', hash, '--expected-prompt-hash', hash];
test('reset parser is closed and requires complete typed guards before any database access', () => {
  assert.deepEqual(parseEvaluationResetArguments([]), { apply: false, restore: null, expectedEvaluations: null, guards: null });
  const parsed = parseEvaluationResetArguments(['--apply', '--expected-evaluations', '955', ...guardArgs]);
  assert.equal(parsed.apply, true); assert.equal(parsed.guards.policyVersion, 6); assert.equal(parsed.expectedEvaluations, 955);
  for (const args of [['--unknown'], ['--apply'], ['--apply', '--apply'], ['--expected-evaluations', '-1'],
    ['--expected-evaluations'], ['--expected-policy-version', '6'], ['--restore', '/tmp/backup.json', ...guardArgs],
    [...guardArgs, '--expected-policy-version', '6'], [...guardArgs.slice(0, -1), 'not-a-hash']]) {
    assert.throws(() => parseEvaluationResetArguments(args));
  }
});

function fixture() {
  const state = createState(false);
  state.catalog = state.catalog.filter(v => v.id === 'cliente_molesto'); state.catalog[0].active = true;
  state.settings = { ...state.settings, dailyEnabled: false, evaluationMaintenance: null,
    aiPolicy: { mode: 'single', primaryId: 'gemma-local', secondaryId: null, fallbackId: null, version: 6 } };
  const registry = new ModelRegistry([{ id: 'gemma-local', provider: 'gateway', model: 'gemma-synthetic', enabled: true,
    evaluator: { configured: true, toolKey: 'gemma', evaluate() { assert.fail('Reset guards must never call AI'); } } }]);
  const context = evaluationContext({ id: 'synthetic', messages: [] }, state.catalog);
  return { state, registry, expected: { policyVersion: 6, configurationHash: registry.snapshot(registry.profiles[0]).configurationHash,
    catalogHash: context.catalogHash, promptHash: context.promptHash } };
}

test('persisted state guards reject policy/configuration/catalog/prompt drift without mutation or AI', () => {
  const { state, registry, expected } = fixture(), original = structuredClone(state);
  assert.doesNotThrow(() => assertGemmaResetPreconditions(state, registry, expected)); assert.deepEqual(state, original);
  for (const key of ['policyVersion', 'configurationHash', 'catalogHash', 'promptHash']) {
    const changed = { ...expected, [key]: key === 'policyVersion' ? 5 : 'f'.repeat(64) };
    assert.throws(() => assertGemmaResetPreconditions(state, registry, changed));
    assert.deepEqual(state, original);
  }
});

test('guards require persisted real metadata, paused daily, available active catalog and idle single Gemma', () => {
  for (const mutate of [s => { delete s.metadata; }, s => { s.metadata.demo = true; },
    s => { s.settings.dailyEnabled = true; }, s => { delete s.settings.dailyEnabled; },
    s => { s.settings.evaluationMaintenance = 'already-running'; }, s => { s.jobs = [{ status: 'queued' }]; },
    s => { s.settings.aiPolicy.mode = 'dual'; }, s => { s.settings.aiPolicy.fallbackId = 'clef-local'; },
    s => { s.catalog[0].active = false; }, s => { s.catalog[0].phase = 2; }]) {
    const { state, registry, expected } = fixture(); mutate(state); const original = structuredClone(state);
    assert.throws(() => assertGemmaResetPreconditions(state, registry, expected)); assert.deepEqual(state, original);
  }
  const { state, registry, expected } = fixture(); registry.profiles[0].enabled = false;
  assert.throws(() => assertGemmaResetPreconditions(state, registry, expected), { code: 'AI_CONFIGURATION' });
});
