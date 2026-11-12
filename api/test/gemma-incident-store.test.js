import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GemmaIncidentStore } from '../src/gemma-incident-store.js';
import { RECOVERY_ID, RECOVERY_JOBS } from '../src/gemma-incident-recovery.js';

const plan = { id: RECOVERY_ID, conversationIds: ['one'], completed: [{ evaluationId: 'preserved' }] };
function fixture() {
  const queries = [], writes = [];
  const rows = { catalog_items: [], catalog_versions: [], model_policies: [],
    evaluation_jobs: [{ id: RECOVERY_JOBS[0] }, { id: 'unrelated', status: 'running' }],
    evaluation_tasks: [{ id: 'task', jobId: RECOVERY_JOBS[0], evaluationId: 'current', status: 'partial' }, { id: 'other-task', jobId: 'unrelated' }],
    evaluation_attempts: [{ id: 'attempt', jobId: RECOVERY_JOBS[0] }, { id: 'other-attempt', jobId: 'unrelated' }],
    operational_refs: [{ id: 'one', evaluationId: 'anchor' }, { id: 'other', evaluationId: 'other-evaluation' }],
    evaluations: ['current', 'preserved', 'anchor', 'other-evaluation'].map(id => ({ id })) };
  const connection = { async query(sql, params = []) {
    queries.push({ sql, params });
    if (sql.includes('FROM app_lock')) return [[{ id: 1 }]];
    if (sql.includes('FROM portal_settings')) return [[{ id: 'settings', payload: { evaluationMaintenance: RECOVERY_ID } }, { id: 'metadata', payload: { demo: false } }]];
    const table = sql.match(/FROM (\w+)/)?.[1];
    assert.ok(rows[table], `Unexpected table: ${table}`);
    const selected = sql.includes(' WHERE ') ? rows[table].filter(r => params.includes(sql.includes('jobId') ? r.jobId : r.id)) : rows[table];
    return [selected.map(payload => ({ payload: structuredClone(payload) }))];
  }, async execute(sql, params) { writes.push({ sql, params }); return [{}]; }, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
  return { connection, queries, writes };
}
test('incident reads retain all global jobs but only scoped tasks, attempts and referenced evaluations', async () => {
  const store = new GemmaIncidentStore({}, plan), f = fixture();
  try {
    const s = await store.load(f.connection);
    assert.equal(s.jobs.length, 2);
    assert.deepEqual(s.tasks.map(t => t.id), ['task']);
    assert.deepEqual(s.attempts.map(t => t.id), ['attempt']);
    assert.deepEqual(s.evaluations.map(e => e.id), ['current', 'preserved', 'anchor']);
    assert.deepEqual(s.operationalRefs.map(r => r.id), ['one']);
    assert.equal(s.settings.evaluationMaintenance, RECOVERY_ID);
    assert.ok(f.queries.every(q => !/FROM (users|sessions|comparison_samples)/.test(q.sql)));
  } finally { await store.close(); }
});
test('scoped transactions retain the global lock and do not rewrite excluded historical records', async () => {
  const store = new GemmaIncidentStore({}, plan), f = fixture();
  await store.close(); store.pool = { async getConnection() { return f.connection; } };
  await store.transaction(s => { s.tasks[0].status = 'completed'; });
  assert.match(f.queries[0].sql, /app_lock.*FOR UPDATE/);
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].sql, /INSERT INTO evaluation_tasks/);
  assert.equal(f.writes[0].params[0], 'task');
  assert.equal(JSON.parse(f.writes[0].params[1]).status, 'completed');
});
