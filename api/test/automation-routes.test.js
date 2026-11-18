import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { DemoStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { AtomReader } from '../src/atom.js';

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'automation-api-'));
  const store = await new DemoStore(path.join(dir, 'state.json')).init();
  const config = { demo: true, basePath: '/pulsoAtom', origin: 'http://127.0.0.1:3000', sessionHours: 8, timezone: 'America/Tegucigalpa' };
  const app = createApp(store, config);
  const admin = request.agent(app), supervisor = request.agent(app);
  await admin.post('/pulsoAtom/api/auth/demo').send({ role: 'admin' }).expect(200);
  await supervisor.post('/pulsoAtom/api/auth/demo').send({ role: 'supervisor' }).expect(200);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  return { app, admin, supervisor, store, config };
}
const base = '/pulsoAtom/api';

test('configuration, verification, preview, save, pause and monitor avoid full historical reads', async t => {
  const f = await setup(t);
  const read = f.store.read.bind(f.store), transaction = f.store.transaction.bind(f.store);
  const calls = { read: 0, write: 0, monitor: 0 };
  f.store.readAuthentication = read;
  f.store.readEvaluationConfiguration = async () => { calls.read++; return read(); };
  f.store.evaluationConfigurationTransaction = async fn => { calls.write++; return transaction(fn); };
  f.store.readAutomationMonitorState = async () => { calls.monitor++; return read(); };
  f.store.read = async () => { throw new Error('Unexpected full history read'); };
  f.store.transaction = async () => { throw new Error('Unexpected full history transaction'); };
  const current = (await f.admin.get(`${base}/evaluations/settings`).expect(200)).body;
  const saved = (await f.admin.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin)
    .send({ expectedVersion: current.settings.version, automation: current.automation }).expect(200)).body;
  const verified = (await f.admin.get(`${base}/evaluations/settings`).expect(200)).body;
  assert.deepEqual(verified.automation, saved.automation);
  await f.admin.post(`${base}/evaluations/settings/preview`).set('Origin', f.config.origin).send({ automation: saved.automation }).expect(200);
  await f.admin.post(`${base}/evaluations/automation/control`).set('Origin', f.config.origin)
    .send({ expectedVersion: saved.settings.version, action: 'pause' }).expect(200);
  await f.admin.get(`${base}/evaluations/automation`).expect(200);
  assert.deepEqual(calls, { read: 4, write: 2, monitor: 1 });
});

test('configuration is admin-only, versioned, persistent, and preserves disabled countries', async t => {
  const f = await setup(t);
  await request(f.app).get(`${base}/evaluations/settings`).expect(401);
  await f.supervisor.get(`${base}/evaluations/settings`).expect(403);
  const current = (await f.admin.get(`${base}/evaluations/settings`).expect(200)).body;
  assert.ok(current.automation.countries.length);
  assert.equal(current.configured, false);
  assert.equal(current.automation.time, '00:01');
  const automation = current.automation;
  automation.countries[0].enabled = true; automation.countries[0].dailyLimit = 37;
  const body = { expectedVersion: current.settings.version, automation };
  await f.supervisor.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin).send(body).expect(403);
  const saved = (await f.admin.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin).send(body).expect(200)).body;
  assert.equal(saved.settings.version, current.settings.version + 1);
  assert.equal(saved.automation.countries[0].dailyLimit, 37);
  await f.admin.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin).send(body).expect(409);
  const read = (await f.admin.get(`${base}/evaluations/settings`)).body;
  assert.deepEqual(read.automation, saved.automation);
  assert.equal((await f.admin.get(`${base}/evaluations/settings/history`)).body.items.length, 2);
});

test('invalid prompts, quotas and duplicate model order cannot partially save', async t => {
  const f = await setup(t);
  const current = (await f.admin.get(`${base}/evaluations/settings`)).body;
  for (const update of [a => { a.countries[0].dailyLimit = 0; }, a => { a.prompts.shared = ' '; }, a => { a.modelOrder = ['clef-local', 'clef-local']; }]) {
    const automation = structuredClone(current.automation); update(automation);
    await f.admin.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin).send({ expectedVersion: current.settings.version, automation }).expect(422);
  }
  assert.equal((await f.store.read()).settings.version, current.settings.version);
});

test('scheduled activation is validated, versioned and retained by pause and prompt restoration', async t => {
  const f = await setup(t);
  const current = (await f.admin.get(`${base}/evaluations/settings`).expect(200)).body;
  const automation = { ...current.automation, startsAt: '2026-11-19T06:01:00.000Z' };
  let saved = (await f.admin.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin)
    .send({ expectedVersion: current.settings.version, automation }).expect(200)).body;
  assert.equal((await f.admin.get(`${base}/evaluations/settings`).expect(200)).body.automation.startsAt, automation.startsAt);
  assert.equal((await f.admin.get(`${base}/evaluations/automation`).expect(200)).body.startsAt, automation.startsAt);
  saved = (await f.admin.post(`${base}/evaluations/automation/control`).set('Origin', f.config.origin)
    .send({ expectedVersion: saved.settings.version, action: 'pause' }).expect(200)).body;
  saved = (await f.admin.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin)
    .send({ expectedVersion: saved.settings.version, restoreVersion: current.settings.version, restoreScope: 'prompts' }).expect(200)).body;
  assert.equal(saved.automation.startsAt, automation.startsAt);
  for (const startsAt of ['tomorrow', '2026-11-19T00:01:00', '2026-11-40T06:01:00Z']) {
    await f.admin.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin)
      .send({ expectedVersion: saved.settings.version, automation: { ...saved.automation, startsAt } }).expect(422);
  }
  assert.equal((await f.store.read()).settings.version, saved.settings.version);
});

test('prompt preview never creates evaluations and restoration creates a new audited version', async t => {
  const f = await setup(t);
  const current = (await f.admin.get(`${base}/evaluations/settings`)).body;
  const initialEvaluations = (await f.store.read()).evaluations.length;
  const automation = current.automation;
  automation.prompts.shared = 'Instrucciones para ambos modelos.';
  const item = current.checklist.find(v => v.method === 'IA');
  automation.prompts.byItem[item.id] = { mode: 'shared', shared: 'Criterio exclusivo de este ítem.' };
  const preview = await f.admin.post(`${base}/evaluations/settings/preview`).set('Origin', f.config.origin).send({ automation }).expect(200);
  assert.equal(preview.body.profiles.length, 2);
  assert.ok(preview.body.profiles.every(p => p.itemPrompts[item.id] === 'Criterio exclusivo de este ítem.'));
  assert.ok(preview.body.profiles.every(p => p.text.startsWith(automation.prompts.shared)));
  assert.equal((await f.store.read()).evaluations.length, initialEvaluations);
  const saved = (await f.admin.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin).send({ expectedVersion: current.settings.version, automation })).body;
  const restored = (await f.admin.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin).send({ expectedVersion: saved.settings.version, restoreVersion: current.settings.version, restoreScope: 'prompts' }).expect(200)).body;
  assert.equal(restored.settings.version, saved.settings.version + 1);
  assert.deepEqual(restored.automation.prompts.byItem, {});
  assert.equal(restored.settings.automationHistory.find(h => h.version === saved.settings.version).configuration.prompts.byItem[item.id].shared, 'Criterio exclusivo de este ítem.');
  assert.notEqual(restored.automation.prompts.shared, automation.prompts.shared);
  assert.equal(restored.settings.automationHistory.at(-1).restoredFrom, current.settings.version);
});

test('country and global pause controls are audited without deleting work', async t => {
  const f = await setup(t);
  let current = (await f.admin.get(`${base}/evaluations/settings`)).body;
  current = (await f.admin.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin).send({ expectedVersion: current.settings.version, automation: current.automation })).body;
  const country = current.automation.countries[0].code;
  current = (await f.admin.post(`${base}/evaluations/automation/control`).set('Origin', f.config.origin).send({ expectedVersion: current.settings.version, country, action: 'pause' }).expect(200)).body;
  assert.equal(current.automation.countries[0].paused, true);
  current = (await f.admin.post(`${base}/evaluations/automation/control`).set('Origin', f.config.origin).send({ expectedVersion: current.settings.version, action: 'pause' }).expect(200)).body;
  assert.equal(current.automation.paused, true);
  await f.supervisor.get(`${base}/evaluations/automation`).expect(403);
  await f.admin.get(`${base}/evaluations/automation`).expect(200);
});

test('prefilled item criteria persist and reach both model previews without truncation or changing other prompts', async t => {
  const f = await setup(t);
  const current = (await f.admin.get(`${base}/evaluations/settings`).expect(200)).body;
  const item = current.checklist.find(v => v.method === 'IA');
  const text = `Definición: ${'D'.repeat(5000)}\nCondición: ${'C'.repeat(5000)}`;
  const automation = structuredClone(current.automation);
  automation.prompts.byItem[item.id] = { mode: 'shared', shared: text };
  const saved = (await f.admin.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin)
    .send({ expectedVersion: current.settings.version, automation }).expect(200)).body;
  const persisted = (await f.admin.get(`${base}/evaluations/settings`).expect(200)).body;
  assert.equal(persisted.automation.prompts.byItem[item.id].shared, text);
  assert.equal(persisted.automation.prompts.shared, current.automation.prompts.shared);
  const preview = (await f.admin.post(`${base}/evaluations/settings/preview`).set('Origin', f.config.origin)
    .send({ automation: saved.automation }).expect(200)).body;
  assert.ok(preview.profiles.every(p => p.itemPrompts[item.id] === text));
  automation.prompts.byItem[item.id].shared = 'X'.repeat(12001);
  await f.admin.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin)
    .send({ expectedVersion: saved.settings.version, automation }).expect(422);
  assert.equal((await f.store.read()).settings.version, saved.settings.version);
});

test('Atom detection queries message activity without loading transcript text and distinguishes load metadata', async () => {
  const reader = Object.create(AtomReader.prototype);
  reader.tables = { conversations: '`conversations`', documents: '`documents`', countries: '`countries`', batches: '`batches`', events: '`events`' };
  const queries = [];
  reader.pool = {
    async query(sql) { queries.push({ sql }); return [[{ code: 1, iso2: 'HN', name: 'Honduras' }]]; },
    async execute(sql, values) { queries.push({ sql, values }); return [[]]; },
  };
  const source = await reader.readAutomationSource({ date: '2026-11-15', timezone: 'America/Tegucigalpa' });
  assert.deepEqual(source.countries, [{ code: 'HN', name: 'Honduras', sourceCode: 1 }]);
  assert.match(queries[0].sql, /OR EXISTS/);
  assert.match(queries[0].sql, /d.Estado = 'LISTO'/);
  assert.doesNotMatch(queries[0].sql.split('FROM')[0], /Texto/);
  assert.equal(queries[0].values[0].toISOString(), '2026-11-15T06:00:00.000Z');
  assert.equal(queries[0].values[1].toISOString(), '2026-11-16T06:00:00.000Z');
});

test('Atom country discovery requires an existing operation without filtering by day or document readiness', async () => {
  const reader = Object.create(AtomReader.prototype);
  reader.tables = { countries: '`corporate`.`countries`', conversations: '`atom`.`conversations`' };
  let query;
  reader.pool = { async query(sql) {
    query = sql;
    return [[{ code: 57, iso2: 'HN', name: 'Honduras' }, { code: 99, iso2: null, name: 'Sin código' }]];
  } };
  assert.deepEqual(await reader.readCountryCatalog(), [{ code: 'HN', name: 'Honduras', sourceCode: 57 }]);
  assert.match(query, /FROM `corporate`\.`countries` p/);
  assert.match(query, /WHERE EXISTS \(SELECT 1 FROM `atom`\.`conversations` c WHERE c\.CodigoPais = p\.CodigoPais\)/);
  assert.doesNotMatch(query, /Fecha|Estado|LISTO|LIMIT/);
});

test('configuration offers every operating country, including those not yet enabled, without the world catalog', async t => {
  const f = await setup(t);
  const countries = [{ code: 'HN', name: 'Honduras' }, { code: 'PA', name: 'Panamá' }, { code: 'CR', name: 'Costa Rica' }];
  f.store.readCountryCatalog = async () => countries;
  await f.store.transaction(state => { state.settings.dailyCountries = ['HN', 'PA']; state.settings.dailyLimitPerCountry = 200; });
  const current = (await f.admin.get(`${base}/evaluations/settings`).expect(200)).body;
  assert.deepEqual(current.countries, countries);
  assert.deepEqual(current.automation.countries.map(c => [c.code, c.enabled, c.dailyLimit]), [['HN', true, 200], ['PA', true, 200], ['CR', false, 100]]);
  const saved = (await f.admin.patch(`${base}/evaluations/settings`).set('Origin', f.config.origin)
    .send({ expectedVersion: current.settings.version, automation: current.automation }).expect(200)).body;
  assert.deepEqual(saved.automation.countries, current.automation.countries);
});
