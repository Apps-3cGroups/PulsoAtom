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
