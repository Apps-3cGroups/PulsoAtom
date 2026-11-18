import test from 'node:test';
import assert from 'node:assert/strict';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { databaseError } from '../src/errors.js';

function fixture() {
  const records = {
    evaluation_jobs: [{ id: 'job', conversationIds: ['conversation'], status: 'running' }, { id: 'newer', conversationIds: ['conversation'] }],
    evaluation_tasks: [{ id: 'task', jobId: 'job', status: 'running', context: { promptHash: 'frozen' }, profileStates: { clef: { results: [{ value: 1 }] } } }, { id: 'other-task', jobId: 'other', status: 'completed' }],
    evaluation_attempts: [{ id: 'attempt', jobId: 'job' }, { id: 'other-attempt', jobId: 'other' }],
    evaluations: [{ id: 'result', jobId: 'job' }, { id: 'anchor', jobId: 'older' }, { id: 'unrelated', jobId: 'other' }],
    operational_refs: [{ id: 'conversation', evaluationId: 'anchor' }, { id: 'unrelated', evaluationId: 'unrelated' }],
  };
  const statements = [], events = [];
  const connection = {
    async beginTransaction() { events.push('begin'); }, async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); }, release() { events.push('release'); },
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (sql.includes('app_lock')) { events.push('lock'); return [[]]; }
      const table = /FROM (\w+)/.exec(sql)?.[1];
      assert.ok(!['evaluations', 'evaluation_tasks', 'evaluation_attempts', 'evaluation_exposures'].includes(table), 'No full-history worker reads');
      return [(records[table] || []).map(payload => ({ payload: structuredClone(payload) }))];
    },
    async execute(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT')) {
        const table = /FROM (\w+)/.exec(sql)[1];
        const rows = (records[table] || []).filter(row => sql.includes('$.jobId') ? row.jobId === params[0] : params.includes(row.id));
        return [rows.map(payload => ({ payload: structuredClone(payload) }))];
      }
      assert.match(sql, /^INSERT INTO evaluation_tasks /);
      records.evaluation_tasks[0] = JSON.parse(params[1]);
      return [[]];
    },
  };
  const store = Object.create(MysqlStore.prototype);
  store.pool = { getConnection: async () => connection };
  return { store, records, statements, events };
}

test('worker reads preserve frozen task data and newer anchors without loading unrelated history', async () => {
  const f = fixture();
  const worker = f.store.evaluationWorker('job');
  const state = await worker.read();
  assert.deepEqual(state.tasks.map(t => t.id), ['task']);
  assert.equal(state.tasks[0].context.promptHash, 'frozen');
  assert.equal(state.tasks[0].profileStates.clef.results[0].value, 1);
  assert.deepEqual(state.evaluations.map(e => e.id), ['result', 'anchor']);
  assert.deepEqual(state.jobs.map(j => j.id), ['job', 'newer'], 'Supersession checks retain newer jobs');
  assert.deepEqual(state.attempts.map(a => a.id), ['attempt']);
  const before = structuredClone(f.records);
  await worker.transaction(s => { s.tasks[0].status = 'completed'; });
  assert.deepEqual(f.records.evaluation_tasks[1], before.evaluation_tasks[1]);
  assert.deepEqual(f.records.evaluations, before.evaluations);
  assert.deepEqual(f.events.slice(-4), ['begin', 'lock', 'commit', 'release']);
  assert.equal(f.statements.filter(s => s.sql.startsWith('INSERT')).length, 1);
});

test('Atom worker hydrates only requested conversations and reuses the scoped store', async () => {
  const f = fixture(); let requested;
  f.store.read = () => { throw new Error('Unexpected full read'); };
  const store = new AtomHistoryStore(f.store, { async read(options) { requested = options; return { conversations: [{ id: 'conversation', messages: [] }], countries: [] }; } });
  const state = await store.evaluationWorker('job').readWithConversations({ fresh: true, conversationIds: ['conversation'] });
  assert.deepEqual(requested, { fresh: true, conversationIds: ['conversation'] });
  assert.equal(state.conversations[0].evaluationId, 'anchor');
  assert.equal(state.tasks.length, 1);
});

test('transient database failures expose a safe retry code without SQL or credentials', () => {
  for (const code of ['ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK', 'ETIMEDOUT', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST']) {
    const error = databaseError(Object.assign(new Error('secret SQL password'), { code, sql: 'sensitive' }));
    assert.equal(error.code, 'DATABASE_TRANSIENT');
    assert.equal(error.details.databaseCode, code);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /secret|password|sensitive/);
  }
  const error = new Error('Programming error');
  assert.equal(databaseError(error), error);
});
