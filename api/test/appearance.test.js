import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { DemoStore, MysqlStore, AtomHistoryStore, UnconfiguredStore } from '../src/store.js';
import { updateAppearance } from '../src/appearance.js';

const config = { demo: true, origin: 'http://127.0.0.1:3000', sessionHours: 8, timezone: 'America/Tegucigalpa' };
const base = '/pulsoAtom/api';
test('appearance is global, admin-only, versioned and persistent without changing evaluation state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulso-appearance-'));
  const store = await new DemoStore(join(directory, 'state.json')).init();
  try {
    await store.transaction(state => {
      Object.assign(state.settings, { dailyEnabled: true, dailyCountries: ['HN', 'PA'], dailyConcurrency: 2, dailyLimitPerCountry: 200, evaluationMaintenance: 'active-recovery' });
      state.jobs.push({ id: 'running-job', status: 'running' });
    });
    const app = createApp(store, config), admin = request.agent(app), supervisor = request.agent(app);
    await admin.post(`${base}/auth/demo`).send({ role: 'admin' }).expect(200);
    await supervisor.post(`${base}/auth/demo`).send({ role: 'supervisor' }).expect(200);
    assert.deepEqual((await request(app).get(`${base}/meta`).expect(200)).body.appearance, { fontScale: 1 });
    await request(app).get(`${base}/access/appearance`).expect(401);
    await request(app).patch(`${base}/access/appearance`).send({ fontScale: 2, expectedVersion: 1 }).expect(401);
    await supervisor.get(`${base}/access/appearance`).expect(403);
    await supervisor.patch(`${base}/access/appearance`).send({ fontScale: 2, expectedVersion: 1 }).expect(403);
    assert.deepEqual((await admin.get(`${base}/access/appearance`).expect(200)).body.appearance, { fontScale: 1, version: 1 });
    const before = await store.read();
    const saved = (await admin.patch(`${base}/access/appearance`).send({ fontScale: 1.5, expectedVersion: 1 }).expect(200)).body.appearance;
    assert.equal(saved.fontScale, 1.5); assert.equal(saved.version, 2); assert.equal(saved.updatedBy, 'demo-admin');
    assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
    const after = await store.read(); delete after.settings.appearance;
    assert.deepEqual(after, before, 'Appearance must not alter evaluation maintenance, scheduler settings, permissions or stored results');
    const rejected = await admin.patch(`${base}/access/appearance`).send({ fontScale: 2, expectedVersion: 1 }).expect(409);
    assert.equal(rejected.body.error.code, 'VERSION_CONFLICT');
    assert.deepEqual((await request(app).get(`${base}/meta`).expect(200)).body.appearance, { fontScale: 1.5 }, 'Public metadata exposes only the scale');
    const reopened = await new DemoStore(store.filename).init();
    assert.deepEqual((await reopened.read()).settings.appearance, saved); await reopened.close();
    const reset = (await admin.patch(`${base}/access/appearance`).send({ fontScale: 1, expectedVersion: 2 }).expect(200)).body.appearance;
    assert.equal(reset.fontScale, 1); assert.equal(reset.version, 3);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('appearance validates numeric tenths from one through two and rejects unrelated settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulso-appearance-range-'));
  const store = await new DemoStore(join(directory, 'state.json')).init();
  try {
    const client = request.agent(createApp(store, config));
    await client.post(`${base}/auth/demo`).send({ role: 'admin' }).expect(200);
    for (const value of [0, 0.9, 2.1, 1.15, '1.5', null]) await client.patch(`${base}/access/appearance`).send({ fontScale: value, expectedVersion: 1 }).expect(422);
    await client.patch(`${base}/access/appearance`).send({ fontScale: 1.5, expectedVersion: 1, dailyEnabled: false }).expect(422);
    await client.patch(`${base}/access/appearance`).send({ fontScale: 1.5, expectedVersion: 0 }).expect(422);
    let version = 1;
    for (let tenth = 10; tenth <= 20; tenth++) {
      const saved = (await client.patch(`${base}/access/appearance`).send({ fontScale: tenth / 10, expectedVersion: version }).expect(200)).body.appearance;
      assert.equal(saved.fontScale, tenth / 10); version = saved.version;
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('MySQL appearance read and write use settings only and share the evaluation transaction lock', async () => {
  let settings = { version: 19, dailyEnabled: true, evaluationMaintenance: 'incident', dailyCountries: ['HN', 'PA'] };
  let staged;
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push('begin'); staged = structuredClone(settings); },
    async query(sql) {
      calls.push(sql);
      if (sql.includes('app_lock')) return [[]];
      assert.equal(sql, 'SELECT id, payload FROM portal_settings');
      return [[{ id: 'settings', payload: JSON.stringify(staged) }]];
    },
    async execute(sql, params) {
      calls.push(sql); assert.match(sql, /^INSERT INTO portal_settings /); assert.equal(params[0], 'settings'); staged = JSON.parse(params[1]); return [{}];
    },
    async commit() { calls.push('commit'); settings = staged; },
    async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); },
  };
  const store = Object.create(MysqlStore.prototype);
  store.pool = {
    async execute(sql) { calls.push(sql); assert.equal(sql, "SELECT payload FROM portal_settings WHERE id = 'settings'"); return [[{ payload: JSON.stringify(settings) }]]; },
    async getConnection() { return connection; },
  };
  const wrapped = new AtomHistoryStore(store, { read() { throw new Error('Appearance must not query Atom'); } });
  assert.deepEqual(await wrapped.readSettings(), settings);
  const saved = await wrapped.settingsTransaction(current => updateAppearance(current, { fontScale: 2, expectedVersion: 1 }, 'admin', '2026-11-12T12:00:00Z'));
  assert.deepEqual(settings, { version: 19, dailyEnabled: true, evaluationMaintenance: 'incident', dailyCountries: ['HN', 'PA'], appearance: saved });
  assert.ok(calls.indexOf('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE') < calls.indexOf('SELECT id, payload FROM portal_settings'));
  assert.ok(calls.includes('commit'));
  assert.ok(calls.every(call => !/evaluation_|model_policies|catalog_items|users|sessions/.test(call)));
  await assert.rejects(wrapped.settingsTransaction(current => updateAppearance(current, { fontScale: 1, expectedVersion: 1 }, 'admin')), { code: 'VERSION_CONFLICT' });
  assert.equal(settings.appearance.fontScale, 2); assert.ok(calls.includes('rollback'));
});

test('unconfigured installations still expose the default visual scale', async () => {
  const response = await request(createApp(new UnconfiguredStore(), { ...config, demo: false })).get(`${base}/meta`).expect(200);
  assert.deepEqual(response.body.appearance, { fontScale: 1 });
});
