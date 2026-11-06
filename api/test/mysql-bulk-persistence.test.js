import assert from 'node:assert/strict';
import test from 'node:test';
import { MysqlStore } from '../src/store.js';
import { createState } from '../src/data/seed.js';
import { ensureEvaluationState } from '../src/evaluation-context.js';

const key = (evaluationId, variableId) => JSON.stringify([evaluationId, variableId]);
function sequentialIndex(database, evaluation) {
  const versions = new Map(evaluation.catalogVersions.map(ref => [ref.id, ref.version]));
  database.evaluations.set(evaluation.id, JSON.parse(JSON.stringify(evaluation)));
  for (const result of evaluation.results) {
    database.results.set(key(evaluation.id, result.variableId), [evaluation.id, result.variableId,
      versions.get(result.variableId), result.status, result.value === undefined ? null : JSON.stringify(result.value), result.reason ?? null]);
    database.evidence = database.evidence.filter(row => row[0] !== evaluation.id || row[1] !== result.variableId);
    for (const evidence of result.evidence || []) database.evidence.push([evaluation.id, result.variableId, evidence.messageId, evidence.quote]);
  }
}
const comparable = database => ({
  evaluations: [...database.evaluations].sort(), results: [...database.results].sort(),
  evidence: [...database.evidence].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
});

// Transactional fake: applies the parameterized writes to staged rows, with
// commit/rollback semantics. No MySQL server or external service is contacted.
function fixture(initial = [], fail = () => false) {
  let database = { evaluations: new Map(), results: new Map(), evidence: [] }, staged;
  for (const evaluation of initial) sequentialIndex(database, evaluation);
  const events = [], statements = [];
  const connection = {
    async beginTransaction() { events.push('begin'); staged = structuredClone(database); },
    async commit() { events.push('commit'); database = staged; staged = undefined; },
    async rollback() { events.push('rollback'); staged = undefined; },
    release() { events.push('release'); },
    async query(sql) { assert.match(sql, /SELECT id FROM app_lock.*FOR UPDATE/); events.push('lock'); return [[]]; },
    async execute(sql, params) {
      statements.push({ sql, params });
      assert.equal((sql.match(/\?/g) || []).length, params.length);
      if (fail(sql, params, statements)) throw new Error('Fallo sintético de persistencia');
      if (sql.startsWith('INSERT INTO evaluations ')) staged.evaluations.set(params[0], JSON.parse(params[1]));
      else if (sql.startsWith('INSERT INTO evaluation_results ')) {
        for (let i = 0; i < params.length; i += 6) {
          const row = params.slice(i, i + 6);
          assert.ok(staged.evaluations.has(row[0]), 'La evaluación debe existir antes de sus resultados');
          staged.results.set(key(row[0], row[1]), row);
        }
      } else if (sql.startsWith('DELETE FROM evaluation_evidence ')) {
        const [evaluationId, ...variableIds] = params;
        staged.evidence = staged.evidence.filter(row => row[0] !== evaluationId || !variableIds.includes(row[1]));
      } else if (sql.startsWith('INSERT INTO evaluation_evidence ')) {
        for (let i = 0; i < params.length; i += 4) {
          const row = params.slice(i, i + 4);
          assert.ok(staged.results.has(key(row[0], row[1])), 'El resultado debe existir antes de su evidencia');
          staged.evidence.push(row);
        }
      } else assert.fail(`SQL inesperado: ${sql}`);
      return [[]];
    },
  };
  const store = Object.create(MysqlStore.prototype);
  store.pool = { getConnection: async () => connection };
  store.load = async () => {
    const state = ensureEvaluationState(createState(false));
    state.evaluations = [...staged.evaluations.values()];
    return structuredClone(state);
  };
  return { store, events, statements, database: () => structuredClone(database) };
}

function evaluation(id, count, evidenceCount = 2) {
  const values = [undefined, null, 0, 1, 2.75, 'disponibilidad', ['Producto sintético']];
  return { id, conversationId: `synthetic-${id}`, catalogVersions: Array.from({ length: count }, (_, i) => ({ id: `var-${i}`, version: i % 3 + 1, active: true })),
    results: Array.from({ length: count }, (_, i) => ({ variableId: `var-${i}`, status: i % 7 === 1 ? 'no_evaluado' : 'evaluado', value: values[i % values.length],
      reason: i % 9 === 0 ? null : `Razón sintética ${i}: apóstrofe ', interrogación ?, Unicode 🟢.`,
      evidence: Array.from({ length: evidenceCount }, (_, j) => ({ messageId: `synthetic-message-${i}-${j}`, quote: `Cita sintética ${i}-${j}: ' ? \\ 🟢` })),
    })) };
}

test('los lotes conservan valores, versiones y evidencias de la persistencia secuencial', async () => {
  const prior = evaluation('updated', 65), untouched = evaluation('untouched', 2);
  const updated = evaluation('updated', 64);
  updated.catalogVersions[0].version = 5;
  updated.results[0].value = ['Lista', 'Actualizada'];
  updated.results[1].evidence = [];
  // Legacy duplicate IDs used to overwrite their earlier value and evidence.
  updated.results.push({ ...updated.results[3], value: 0, evidence: [{ messageId: 'replacement', quote: 'Última evidencia sintética.' }] });
  const f = fixture([prior, untouched]);
  const expected = f.database(); sequentialIndex(expected, updated);
  await f.store.transaction(state => { state.evaluations[0] = updated; });
  assert.deepEqual(comparable(f.database()), comparable(expected));
  assert.deepEqual(f.events, ['begin', 'lock', 'commit', 'release']);
  // 64 results + 125 quotes take five writes instead of over 250 sequential writes.
  assert.equal(f.statements.length, 5);
  for (const { sql } of f.statements) assert.doesNotMatch(sql, /Cita sintética|Razón sintética|Última evidencia|Producto sintético/);
  assert.equal(f.database().results.get(key('updated', 'var-7'))[4], null, 'undefined sigue siendo SQL NULL');
  assert.equal(f.database().results.get(key('updated', 'var-1'))[4], 'null', 'null sigue siendo JSON null');
});

test('lotes grandes usan parámetros acotados y conservan todos los valores entre fragmentos', async () => {
  const item = evaluation('large', 205, 3);
  for (let i = 0; i < 10; i++) item.results[i].evidence[0].quote = 'Texto sintético 🟢 '.repeat(1800);
  const f = fixture(); const expected = f.database(); sequentialIndex(expected, item);
  await f.store.transaction(state => state.evaluations.push(item));
  assert.deepEqual(comparable(f.database()), comparable(expected));
  const resultWrites = f.statements.filter(s => s.sql.startsWith('INSERT INTO evaluation_results '));
  const evidenceWrites = f.statements.filter(s => s.sql.startsWith('INSERT INTO evaluation_evidence '));
  assert.equal(resultWrites.length, 3);
  assert.ok(resultWrites.every(s => s.params.length <= 600));
  assert.ok(evidenceWrites.every(s => s.params.length <= 400));
  assert.ok(evidenceWrites.every(s => s.params.reduce((bytes, value) => bytes + Buffer.byteLength(String(value ?? ''), 'utf8') + 16, 0) <= 256 * 1024));
  assert.equal(evidenceWrites.reduce((total, s) => total + s.params.length / 4, 0), 615);
  assert.ok(f.statements.length < 20);
});

test('un fallo de escritura revierte payload, resultados y evidencia completos sin tocar el histórico', async () => {
  const prior = evaluation('updated', 3), untouched = evaluation('untouched', 2);
  const f = fixture([prior, untouched], (sql, params, statements) => sql.startsWith('INSERT INTO evaluation_evidence ')
    && statements.filter(s => s.sql.startsWith('INSERT INTO evaluation_evidence ')).length === 2);
  const before = comparable(f.database());
  await assert.rejects(f.store.transaction(state => { state.evaluations[0] = evaluation('updated', 64, 3); }), /Fallo sintético/);
  assert.deepEqual(comparable(f.database()), before);
  assert.deepEqual(f.events, ['begin', 'lock', 'rollback', 'release']);
  assert.equal(f.statements.filter(s => s.sql.startsWith('INSERT INTO evaluation_evidence ')).length, 2);
});

test('una evaluación sin resultados no ejecuta SQL vacío ni borra índices históricos', async () => {
  const prior = evaluation('updated', 2);
  const empty = { ...prior, results: [] };
  const f = fixture([prior]); const expected = f.database(); sequentialIndex(expected, empty);
  await f.store.transaction(state => { state.evaluations[0] = empty; });
  assert.deepEqual(comparable(f.database()), comparable(expected));
  assert.equal(f.statements.length, 1);
});
