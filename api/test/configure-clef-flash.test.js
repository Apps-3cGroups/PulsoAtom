import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planClefFlashConfiguration, configureClefFlash } from '../scripts/configure-clef-flash.js';
import { registryFromEnv } from '../src/model-registry.js';

const now = '2026-11-07T22:00:00.000Z';
function fixture() {
  return { version: 11, dailyEnabled: false, dailyTime: '07:00', timezone: 'America/Tegucigalpa',
    evaluationMaintenance: '77f134e8-fdf8-4154-b1f6-485c159b9194',
    aiPolicy: { version: 6, mode: 'single', primaryId: 'gemma-local', secondaryId: null, fallbackId: null },
    localModelConfiguration: { version: 3, profiles: [
      { id: 'clef-local', label: 'Clef', toolKey: 'gemma', model: 'cloudflare_clef', enabled: true, responseFormat: 'json_schema' },
      { id: 'gemma-local', label: 'Gemma', toolKey: 'gemma', model: 'gemma-4-26b-a4b-it-mlx', enabled: true, responseFormat: 'json_schema' },
    ], updatedBy: 'Prior operator', updatedAt: '2026-11-06T00:00:00.000Z' },
    localModelConfigurationHistory: [{ version: 2, profiles: [], updatedBy: 'Historical operator' }],
    gemmaRenewalConfigurationHash: 'unchanged-gemma-hash', modelDiagnostics: { private: 'PRIVATE_DIAGNOSTIC' },
    unrelatedSetting: { retained: true },
  };
}
function database(settings = fixture(), counts = {}) {
  let saved = structuredClone(settings), pending, inTransaction = false;
  const calls = [];
  return { calls, read: () => structuredClone(saved),
    async beginTransaction() { inTransaction = true; calls.push('BEGIN'); },
    async query(sql) {
      calls.push(sql);
      if (sql === 'SELECT id FROM app_lock WHERE id = 1 FOR UPDATE') { assert.ok(inTransaction); return [[{ id: 1 }]]; }
      if (sql.includes('FROM evaluation_jobs')) return [[{ activeJobs: 0, activeTasks: 0, activeAttempts: 0, evaluations: 652, operationalRefs: 500, ...counts }]];
      assert.ok(["SELECT payload FROM portal_settings WHERE id = 'settings' FOR UPDATE", "SELECT payload FROM portal_settings WHERE id = 'settings'"].includes(sql));
      return [[{ payload: JSON.stringify(pending || saved) }]];
    },
    async execute(sql, args) {
      assert.ok(inTransaction); calls.push(sql);
      assert.equal(sql, "UPDATE portal_settings SET payload = ? WHERE id = 'settings'");
      assert.equal(args.length, 1); pending = JSON.parse(args[0]); return [{ affectedRows: 1 }];
    },
    async commit() { if (pending) saved = pending; pending = undefined; inTransaction = false; calls.push('COMMIT'); },
    async rollback() { pending = undefined; inTransaction = false; calls.push('ROLLBACK'); },
  };
}

test('only the Clef model/protocol and versioned configuration audit change', () => {
  const before = fixture(), unchanged = structuredClone(before);
  const { settings: after, changed } = planClefFlashConfiguration(before, { now });
  assert.equal(changed, true); assert.deepEqual(before, unchanged);
  assert.deepEqual(after.localModelConfiguration.profiles[0], { ...before.localModelConfiguration.profiles[0], model: 'clef-flash', protocol: 'chat' });
  assert.deepEqual(after.localModelConfiguration.profiles[1], before.localModelConfiguration.profiles[1]);
  assert.equal(after.version, 12); assert.equal(after.localModelConfiguration.version, 4);
  for (const key of Object.keys(before).filter(key => !['version', 'localModelConfiguration', 'localModelConfigurationHistory'].includes(key))) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(after.localModelConfigurationHistory.find(item => item.version === 3), before.localModelConfiguration);
  assert.deepEqual(after.localModelConfigurationHistory.find(item => item.version === 4), after.localModelConfiguration);
  assert.deepEqual(after.localModelConfigurationHistory[0], before.localModelConfigurationHistory[0]);
});

test('Gemma runtime snapshot/hash and single-model policy remain unchanged', () => {
  const settings = fixture(), next = planClefFlashConfiguration(settings, { now }).settings;
  const registry = registryFromEnv({ env: { GATEWAY_BASE_URL: 'http://gateway.synthetic', AGENT_SHARED_TOKEN: 'synthetic-token' } });
  const before = registry.forState({ settings }), after = registry.forState({ settings: next });
  assert.deepEqual(after.snapshot(after.resolve('gemma-local')), before.snapshot(before.resolve('gemma-local')));
  assert.notEqual(after.snapshot(after.resolve('clef-local')).configurationHash, before.snapshot(before.resolve('clef-local')).configurationHash);
  assert.deepEqual(after.policy({ settings: next }), before.policy({ settings }));
});

test('already configured chat is idempotent, including the implicit chat default', () => {
  const first = planClefFlashConfiguration(fixture(), { now }).settings;
  assert.deepEqual(planClefFlashConfiguration(first, { now: '2026-11-08T00:00:00Z' }), { settings: first, changed: false });
  const prior = fixture(); prior.localModelConfiguration.profiles[0].model = 'clef-flash';
  assert.deepEqual(planClefFlashConfiguration(prior, { now }), { settings: prior, changed: false });
});

test('any active job, task, or attempt stops both planning and database mutation', async () => {
  for (const key of ['activeJobs', 'activeTasks', 'activeAttempts']) {
    assert.throws(() => planClefFlashConfiguration(fixture(), { [key]: 1 }), error => error.code === 'EVALUATION_RUNNING');
    const db = database(fixture(), { [key]: 1 });
    await assert.rejects(configureClefFlash(db, { apply: true, now }), error => error.code === 'EVALUATION_RUNNING');
    assert.equal(db.calls.some(sql => sql.startsWith('UPDATE')), false);
    assert.equal(db.calls.at(-1), 'ROLLBACK');
  }
});

test('policy, maintenance, format, protocol, and audit drift fail closed without touching input', () => {
  const mutations = [
    s => { s.aiPolicy.version = 7; }, s => { s.aiPolicy.mode = 'dual'; }, s => { s.aiPolicy.primaryId = 'clef-local'; },
    s => { s.aiPolicy.secondaryId = 'clef-local'; }, s => { s.aiPolicy.fallbackId = 'clef-local'; },
    s => { s.dailyEnabled = true; }, s => { s.evaluationMaintenance = null; }, s => { s.version = 0; },
    s => { s.localModelConfiguration.version = 0; }, s => { s.localModelConfiguration.profiles.pop(); },
    s => { s.localModelConfiguration.profiles[0].toolKey = 'qwen'; }, s => { s.localModelConfiguration.profiles[0].model = 'other'; },
    s => { s.localModelConfiguration.profiles[0].protocol = 'systemone'; }, s => { s.localModelConfiguration.profiles[0].enabled = false; },
    s => { s.localModelConfiguration.profiles[0].responseFormat = 'json_object'; },
    s => { s.localModelConfiguration.profiles[1].toolKey = 'other'; }, s => { s.localModelConfiguration.profiles[1].model = 'other'; },
    s => { s.localModelConfiguration.profiles[1].enabled = false; }, s => { s.localModelConfiguration.profiles[1].responseFormat = 'json_object'; },
    s => { s.localModelConfigurationHistory.push({ version: 3, profiles: [] }); },
    s => { s.localModelConfigurationHistory.push({ version: 4, profiles: [] }); },
    s => { s.localModelConfigurationHistory.push(structuredClone(s.localModelConfigurationHistory[0])); },
  ];
  for (const mutate of mutations) {
    const settings = fixture(); mutate(settings); const before = structuredClone(settings);
    assert.throws(() => planClefFlashConfiguration(settings, { now }));
    assert.deepEqual(settings, before);
  }
});

test('inspect is read-only; apply updates exactly one settings row and reapply writes nothing', async () => {
  const db = database(), before = db.read();
  const inspection = await configureClefFlash(db, { now });
  assert.equal(inspection.wouldChange, true); assert.equal(inspection.changed, false);
  assert.equal(inspection.profile.model, 'cloudflare_clef'); assert.equal(inspection.plannedProfile.model, 'clef-flash');
  assert.deepEqual(db.read(), before); assert.equal(db.calls.some(sql => sql.startsWith('UPDATE')), false);
  const applied = await configureClefFlash(db, { apply: true, now });
  assert.equal(applied.changed, true); assert.equal(applied.profile.protocol, 'chat'); assert.equal(applied.dailyEnabled, false);
  assert.equal(applied.readbackVerified, true); assert.equal(applied.counts.evaluations, 652); assert.equal(applied.counts.operationalRefs, 500);
  const repeated = await configureClefFlash(db, { apply: true, now });
  assert.equal(repeated.changed, false); assert.equal(db.calls.filter(sql => sql.startsWith('UPDATE')).length, 1);
  assert.ok(!JSON.stringify([inspection, applied, repeated]).includes('PRIVATE_DIAGNOSTIC'));
  assert.equal(db.calls.some(sql => /^(INSERT|DELETE)/.test(sql)), false);
});
