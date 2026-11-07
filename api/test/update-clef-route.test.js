import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planClefRouteUpdate } from '../scripts/update-clef-route.js';
import { registryFromEnv } from '../src/model-registry.js';

const maintenanceId = '77f134e8-fdf8-4154-b1f6-485c159b9194';
const now = '2026-11-07T19:00:00.000Z';
function fixture() {
  return {
    version: 12, dailyEnabled: false, dailyTime: '07:00', timezone: 'America/Tegucigalpa',
    evaluationMaintenance: maintenanceId, lastBackfillId: 'historical-maintenance',
    gemmaRenewalConfigurationHash: 'retained-gemma-hash',
    aiPolicy: { version: 6, mode: 'single', primaryId: 'gemma-local', secondaryId: null, fallbackId: null,
      updatedAt: '2026-11-06T15:00:00.000Z', updatedBy: 'Prior operator' },
    localModelConfiguration: { version: 3,
      profiles: [
        { id: 'clef-local', label: 'Clef', toolKey: 'qwen', model: 'clef-flash', enabled: true, responseFormat: 'json_schema' },
        { id: 'gemma-local', label: 'Gemma', toolKey: 'gemma', model: 'gemma-4-26b-a4b-it-mlx', enabled: true, responseFormat: 'json_schema' },
      ], updatedAt: '2026-11-06T14:00:00.000Z', updatedBy: 'Original operator',
    },
    localModelConfigurationHistory: [{ version: 2, profiles: [], updatedBy: 'Historical operator' }],
    unrelatedSetting: { retain: true },
  };
}

test('Clef route update preserves the Gemma profile, policy, maintenance and existing settings', () => {
  const settings = fixture(), before = structuredClone(settings);
  const result = planClefRouteUpdate(settings, { now });
  assert.equal(result.changed, true);
  assert.deepEqual(settings, before, 'Planning must not mutate its input');
  const after = result.settings;
  assert.equal(after.version, before.version + 1);
  assert.equal(after.localModelConfiguration.version, before.localModelConfiguration.version + 1);
  const clef = after.localModelConfiguration.profiles.find(p => p.id === 'clef-local');
  assert.deepEqual(clef, { ...before.localModelConfiguration.profiles[0], toolKey: 'gemma', model: 'cloudflare_clef' });
  assert.deepEqual(after.localModelConfiguration.profiles.find(p => p.id === 'gemma-local'), before.localModelConfiguration.profiles[1]);
  for (const key of Object.keys(before).filter(key => !['version', 'localModelConfiguration', 'localModelConfigurationHistory'].includes(key))) {
    assert.deepEqual(after[key], before[key], `Must preserve settings.${key}`);
  }
  assert.deepEqual(after.localModelConfigurationHistory[0], before.localModelConfigurationHistory[0]);
  assert.deepEqual(after.localModelConfigurationHistory.find(item => item.version === 3), before.localModelConfiguration);
  assert.deepEqual(after.localModelConfigurationHistory.find(item => item.version === 4), after.localModelConfiguration);
});

test('Clef edits do not invalidate the frozen Gemma configuration hash', () => {
  const settings = fixture();
  const result = planClefRouteUpdate(settings, { now });
  const registry = registryFromEnv({ env: { GATEWAY_BASE_URL: 'http://gateway.synthetic', AGENT_SHARED_TOKEN: 'synthetic-token' } });
  const before = registry.forState({ settings }), after = registry.forState({ settings: result.settings });
  assert.deepEqual(after.snapshot(after.resolve('gemma-local')), before.snapshot(before.resolve('gemma-local')));
  assert.notEqual(after.snapshot(after.resolve('clef-local')).configurationHash, before.snapshot(before.resolve('clef-local')).configurationHash);
  assert.deepEqual(after.policy({ settings: result.settings }), before.policy({ settings }));
  assert.equal(after.policyAvailable({ settings: result.settings }), true);
});

test('reapplying the exact Clef route is an idempotent no-op', () => {
  const first = planClefRouteUpdate(fixture(), { now });
  const second = planClefRouteUpdate(first.settings, { now: '2026-11-07T20:00:00.000Z' });
  assert.equal(second.changed, false);
  assert.deepEqual(second.settings, first.settings);
});

test('active jobs, tasks or attempts prevent a configuration change', () => {
  for (const key of ['activeJobs', 'activeTasks', 'activeAttempts']) {
    const settings = fixture(), before = structuredClone(settings);
    assert.throws(() => planClefRouteUpdate(settings, { [key]: 1, now }), key);
    assert.deepEqual(settings, before);
  }
});

test('policy, maintenance, version and profile drift fail closed', () => {
  const mutations = [
    state => { state.aiPolicy.version = 7; },
    state => { state.aiPolicy.mode = 'dual'; },
    state => { state.aiPolicy.primaryId = 'clef-local'; },
    state => { state.aiPolicy.secondaryId = 'clef-local'; },
    state => { state.aiPolicy.fallbackId = 'clef-local'; },
    state => { state.dailyEnabled = true; },
    state => { state.evaluationMaintenance = null; },
    state => { state.evaluationMaintenance = '00000000-1111-4222-8333-444444444444'; },
    state => { state.version = 0; },
    state => { state.localModelConfiguration.version = 0; },
    state => { state.localModelConfiguration.profiles.pop(); },
    state => { state.localModelConfiguration.profiles.push(structuredClone(state.localModelConfiguration.profiles[0])); },
    state => { state.localModelConfiguration.profiles[0].model = 'unexpected-clef'; },
    state => { state.localModelConfiguration.profiles[0].toolKey = 'other'; },
    state => { state.localModelConfiguration.profiles[1].model = 'another-gemma'; },
    state => { state.localModelConfiguration.profiles[1].toolKey = 'qwen'; },
    state => { state.localModelConfiguration.profiles[1].enabled = false; },
  ];
  for (const mutate of mutations) {
    const settings = fixture(); mutate(settings);
    const before = structuredClone(settings);
    assert.throws(() => planClefRouteUpdate(settings, { now }));
    assert.deepEqual(settings, before);
  }
});

test('unexpected Clef activation or format changes stop the narrow route update', () => {
  for (const change of [profile => { profile.enabled = false; }, profile => { profile.responseFormat = 'json_object'; }]) {
    const settings = fixture();
    change(settings.localModelConfiguration.profiles.find(p => p.id === 'clef-local'));
    assert.throws(() => planClefRouteUpdate(settings), error => error.code === 'CLEF_CONFIGURATION_CHANGED');
  }
});
