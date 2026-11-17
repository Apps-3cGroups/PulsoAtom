import test from 'node:test';
import assert from 'node:assert/strict';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { createState } from '../src/data/seed.js';
import { automationConfiguration, saveAutomationConfiguration, migrateDailyAssignments } from '../src/automation-configuration.js';
import { automationMonitor } from '../src/automation-routes.js';
import { refreshAutomationJob } from '../src/automation-scheduler.js';

function fixture() {
  const initial = createState(false);
  initial.settings.automation = automationConfiguration(initial.settings, [{ code: 'HN', name: 'Honduras' }]);
  initial.settings.automation.enabled = true;
  initial.settings.automation.countries[0].enabled = true;
  const auto = { id: 'auto', status: 'queued', automation: { activityDate: '2026-11-17' },
    conversationCountries: { c1: 'HN' }, modelProfiles: [{ id: 'clef-local' }, { id: 'gemma-local' }],
    completed: 1, total: 2, untouched: 'full job retained' };
  let database = {
    catalog_items: initial.catalog,
    portal_settings: [{ id: 'settings', value: initial.settings }, { id: 'metadata', value: initial.metadata }],
    evaluation_jobs: [auto, { ...auto, id: 'running', status: 'running' },
      { id: 'legacy', dailyActivity: { date: '2026-11-16' }, conversationIds: ['old'], conversationCountries: { old: 'HN' } },
      { id: 'manual', status: 'running', privateSnapshot: 'unrelated history' }],
    evaluation_daily_assignments: [{ id: 'assigned', activityDate: '2026-11-17', country: 'HN', conversationId: 'c1', jobId: 'auto' }],
    evaluation_tasks: [
      { id: 'done', jobId: 'auto', conversationId: 'c1', status: 'completed', profile: { id: 'clef-local', model: 'private model' }, codeResults: ['retained'] },
      { id: 'pending', jobId: 'auto', conversationId: 'c1', status: 'pending', profile: { id: 'gemma-local' }, context: { prompt: 'retained' } },
      { id: 'running-task', jobId: 'running', conversationId: 'c1', status: 'running', profile: { id: 'gemma-local' } },
      { id: 'unrelated', jobId: 'manual', status: 'completed', results: ['retained'] },
    ],
  }, staged;
  const queries = [], writes = [], events = [];
  const connection = {
    async beginTransaction() { events.push('begin'); staged = structuredClone(database); },
    async commit() { events.push('commit'); database = staged; },
    async rollback() { events.push('rollback'); }, release() { events.push('release'); },
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('FROM app_lock')) { events.push('lock'); return [[{ id: 1 }]]; }
      const table = sql.match(/FROM (\w+)/)?.[1];
      assert.ok(staged[table], `Unexpected historical table: ${table}`);
      let rows = staged[table];
      if (table === 'portal_settings') return [rows.map(r => ({ id: r.id, payload: structuredClone(r.value) }))];
      if (table === 'evaluation_jobs') {
        assert.match(sql, /WHERE JSON_TYPE/);
        rows = rows.filter(r => r.automation || r.dailyActivity);
      }
      if (table === 'evaluation_tasks') {
        assert.match(sql, /SELECT JSON_OBJECT/);
        assert.match(sql, /WHERE JSON_UNQUOTE\(JSON_EXTRACT\(payload, '\$\.jobId'\)\) IN/);
        assert.doesNotMatch(sql, /codeResults|context|results|prompt/);
        rows = rows.filter(r => params.includes(r.jobId)).map(r => ({
          id: r.id, jobId: r.jobId, conversationId: r.conversationId, status: r.status,
          nextAttemptAt: r.nextAttemptAt ?? null, error: r.error ?? null, profile: { id: r.profile?.id },
        }));
      }
      return [rows.map(payload => ({ payload: structuredClone(payload) }))];
    },
    async execute(sql, params) {
      writes.push({ sql, params });
      const table = sql.match(/INSERT INTO (\w+)/)?.[1];
      assert.ok(['portal_settings', 'evaluation_jobs', 'evaluation_daily_assignments'].includes(table), sql);
      const value = JSON.parse(params[1]);
      const next = table === 'portal_settings' ? { id: params[0], value } : value;
      const index = staged[table].findIndex(r => r.id === params[0]);
      if (index < 0) staged[table].push(next); else staged[table][index] = next;
      return [{}];
    },
  };
  const store = Object.create(MysqlStore.prototype);
  store.pool = { getConnection: async () => connection };
  return { store, queries, writes, events, database: () => structuredClone(database) };
}

test('configuration read and confirmation load only the checklist and settings', async () => {
  const f = fixture();
  const state = await f.store.readEvaluationConfiguration();
  assert.equal(state.settings.version, 1);
  assert.ok(state.catalog.length);
  assert.deepEqual(state.jobs, []);
  assert.deepEqual(state.tasks, []);
  assert.equal(f.queries.length, 2);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.events, ['begin', 'commit', 'release']);
});

test('configuration save retains lock, migration and pause behavior without rewriting task snapshots or unrelated jobs', async () => {
  const f = fixture(), before = f.database();
  await f.store.evaluationConfigurationTransaction(state => {
    assert.deepEqual(state.tasks.map(t => t.id), ['done', 'pending']);
    const automation = structuredClone(state.settings.automation);
    automation.countries[0].paused = true;
    migrateDailyAssignments(state);
    saveAutomationConfiguration(state, { expectedVersion: 1, automation }, { id: 'test', name: 'Prueba' });
    for (const job of state.jobs.filter(j => j.automation && j.status !== 'running')) refreshAutomationJob(state, job);
  });
  const after = f.database();
  assert.deepEqual(f.events, ['begin', 'lock', 'commit', 'release']);
  assert.equal(after.portal_settings[0].value.version, 2);
  assert.equal(after.evaluation_jobs.find(j => j.id === 'auto').status, 'paused');
  assert.equal(after.evaluation_jobs.find(j => j.id === 'auto').untouched, 'full job retained');
  assert.ok(after.evaluation_daily_assignments.some(a => a.jobId === 'legacy' && a.conversationId === 'old'));
  assert.deepEqual(after.evaluation_tasks, before.evaluation_tasks);
  for (const id of ['running', 'manual']) assert.deepEqual(after.evaluation_jobs.find(j => j.id === id), before.evaluation_jobs.find(j => j.id === id));
  assert.ok(f.writes.every(w => !/evaluation_tasks|evaluations\b|evaluation_attempts/.test(w.sql)));
});

test('version conflict and accidental task edits roll back the scoped transaction', async () => {
  for (const mutate of [
    state => saveAutomationConfiguration(state, { expectedVersion: 99, automation: state.settings.automation }, { name: 'Prueba' }),
    state => { state.tasks[0].status = 'failed'; },
  ]) {
    const f = fixture(), before = f.database();
    await assert.rejects(f.store.evaluationConfigurationTransaction(mutate));
    assert.deepEqual(f.database(), before);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.events, ['begin', 'lock', 'rollback', 'release']);
  }
});

test('monitor reads compact tasks including running jobs and preserves country counters', async () => {
  const f = fixture();
  const state = await f.store.readAutomationMonitorState();
  assert.ok(state.tasks.some(t => t.id === 'running-task'));
  assert.ok(!state.tasks.some(t => t.id === 'unrelated'));
  const report = automationMonitor(state, '2026-11-17');
  assert.equal(report.countries[0].selected, 1);
  assert.equal(report.countries[0].models['clef-local'].completed, 1);
  assert.equal(report.countries[0].models['gemma-local'].pending, 1);
  assert.deepEqual(f.writes, []);
});

test('Atom wrapper delegates configuration and monitor to the scoped store', async () => {
  const calls = [];
  const base = Object.fromEntries(['readEvaluationConfiguration', 'evaluationConfigurationTransaction', 'readAutomationMonitorState']
    .map(name => [name, async () => { calls.push(name); return name; }]));
  const store = new AtomHistoryStore(base, {});
  await store.readEvaluationConfiguration();
  await store.evaluationConfigurationTransaction(() => {});
  await store.readAutomationMonitorState();
  assert.deepEqual(calls, Object.keys(base));
});
