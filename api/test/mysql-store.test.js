import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MysqlStore } from '../src/store.js';

test('el esquema propio no crea una copia de conversaciones de Atom', async () => {
  const sql = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS source_conversation_refs/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS evaluation_results/);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS conversations\s*\(/);
});

test('guardar una evaluación indexa resultados y evidencia sin escribir mensajes de Atom', async () => {
  const statements = [];
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async sql => { statements.push(sql); return [[]]; },
    execute: async (sql, params) => { statements.push([sql, params]); return [[]]; },
  };
  const store = Object.create(MysqlStore.prototype);
  store.pool = { getConnection: async () => connection };
  await store.transaction(state => {
    state.evaluations.push({
      id: 'eval-atom-1', conversationId: 'atom-1', createdAt: new Date().toISOString(),
      catalogVersions: [{ id: 'cliente_molesto', version: 2, active: true }],
      results: [{ variableId: 'cliente_molesto', status: 'evaluado', value: 1, reason: 'Prueba', evidence: [{ messageId: 'msg-1', quote: 'Cita' }] }],
    });
  });
  const sql = statements.map(entry => typeof entry === 'string' ? entry : entry[0]).join('\n');
  assert.match(sql, /INSERT INTO evaluations/);
  assert.match(sql, /INSERT INTO evaluation_results/);
  assert.match(sql, /INSERT INTO evaluation_evidence/);
  assert.doesNotMatch(sql, /(?:SELECT|INSERT INTO) conversations\b/);
  assert.deepEqual(statements.find(entry => Array.isArray(entry) && entry[0].startsWith('INSERT INTO evaluation_results'))[1].slice(0, 4), ['eval-atom-1', 'cliente_molesto', 2, 'evaluado']);
});
