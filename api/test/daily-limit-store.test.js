import test from 'node:test';
import assert from 'node:assert/strict';
import { DailyLimitStore } from '../src/daily-limit-store.js';

function fixture() {
  const writes = [], events = [];
  const connection = {
    async beginTransaction() { events.push('begin'); }, async commit() { events.push('commit'); }, async rollback() { events.push('rollback'); }, release() { events.push('release'); },
    async query(sql) {
      if (sql.includes('app_lock')) { events.push('lock'); return [[{ id: 1 }]]; }
      if (sql.includes('portal_settings')) return [[{ payload: { version: 1 } }]];
      if (sql.includes('evaluation_jobs')) return [[{ payload: { id: 'job', conversationIds: ['c'], untouched: 'keep' } }]];
      if (sql.includes('evaluation_tasks')) return [[{ payload: { id: 'task', jobId: 'job', conversationId: 'c', status: 'pending' } }]];
      if (sql.includes('evaluation_attempts')) return [[]];
      if (sql.includes('FROM evaluations')) return [[{ payload: { id: 'eval', jobId: 'other', taskId: 'other', conversationId: 'old' } }]];
      throw new Error(sql);
    },
    async execute(sql, values) { writes.push({ sql, values }); return [{ affectedRows: 1 }]; },
  };
  const store = Object.create(DailyLimitStore.prototype);
  store.pool = { async getConnection() { return connection; } };
  return { store, writes, events };
}

test('el ajuste escribe parches de estado y conserva el JSON completo de tareas y resultados', async () => {
  const { store, writes, events } = fixture();
  await store.transaction(state => {
    state.tasks[0].status = 'deferred'; state.tasks[0].deferredReason = 'daily-country-limit';
    state.settings.version++;
  });
  assert.deepEqual(events, ['begin', 'lock', 'commit', 'release']);
  assert.equal(writes.length, 2);
  assert.match(writes[0].sql, /UPDATE evaluation_tasks SET payload = JSON_MERGE_PATCH\(payload, CAST\(\? AS JSON\)\)/);
  assert.deepEqual(JSON.parse(writes[0].values[0]), { status: 'deferred', deferredReason: 'daily-country-limit' });
  assert.deepEqual(writes[0].values.slice(1), ['task']);
  assert.ok(writes.every(w => !/UPDATE evaluations\b|DELETE|INSERT/.test(w.sql)));
});

test('el adaptador revierte cualquier intento de modificar resultados o borrar tareas', async () => {
  for (const change of [state => { state.evaluations[0].jobId = 'wrong'; }, state => { state.tasks.pop(); }]) {
    const { store, writes, events } = fixture();
    await assert.rejects(store.transaction(change));
    assert.deepEqual(writes, []); assert.deepEqual(events, ['begin', 'lock', 'rollback', 'release']);
  }
});
