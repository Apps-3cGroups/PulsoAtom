import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { createState } from './data/seed.js';
import { missingDatabase } from './errors.js';
import { ensureEvaluationState } from './evaluation-context.js';
import { migrateCatalogV5 } from './catalog-v5.js';

export class DemoStore {
  constructor(filename) { this.filename = filename; this.queue = Promise.resolve(); }
  async init() {
    try {
      this.state = JSON.parse(await readFile(this.filename, 'utf8'));
      if (this.state.schemaVersion !== 1 || !this.state.metadata?.demo) throw new Error('Archivo de demostración incompatible. Consérvalo antes de crear otro.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = createState(true); await this.persist(this.state);
    }
    ensureEvaluationState(this.state);
    if (migrateCatalogV5(this.state)) await this.persist(this.state);
    return this;
  }
  async persist(state) {
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temp = `${this.filename}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, this.filename);
  }
  async read() { await this.queue; return structuredClone(this.state); }
  async transaction(fn) {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      await this.persist(draft);
      this.state = draft;
      return structuredClone(result);
    });
    this.queue = run.catch(() => {});
    return run;
  }
  async close() { await this.queue; }
}

export class UnconfiguredStore {
  async read() { throw missingDatabase(); }
  async transaction() { throw missingDatabase(); }
  async close() {}
}

const tables = {
  catalog: 'catalog_items', catalogVersions: 'catalog_versions', catalogAudit: 'catalog_audit',
  users: 'users', sessions: 'sessions', evaluations: 'evaluations',
  reviews: 'review_events', jobs: 'evaluation_jobs',
  operationalRefs: 'operational_refs', comparisons: 'comparison_samples', tasks: 'evaluation_tasks',
  attempts: 'evaluation_attempts', verdicts: 'human_verdicts', exposures: 'evaluation_exposures', validations: 'validation_sessions',
  modelPolicies: 'model_policies',
};
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const MAX_BATCH_ROWS = 100;
const MAX_BATCH_BYTES = 256 * 1024;
function* rowBatches(rows) {
  let batch = [], bytes = 0;
  for (const row of rows) {
    const size = row.reduce((total, value) => total + Buffer.byteLength(String(value ?? ''), 'utf8') + 16, 0);
    if (batch.length && (batch.length >= MAX_BATCH_ROWS || bytes + size > MAX_BATCH_BYTES)) {
      yield batch; batch = []; bytes = 0;
    }
    batch.push(row); bytes += size;
  }
  if (batch.length) yield batch;
}
async function insertRows(connection, statement, rows, suffix = '') {
  for (const batch of rowBatches(rows)) {
    const placeholders = batch.map(row => `(${row.map(() => '?').join(', ')})`).join(', ');
    await connection.execute(`${statement} VALUES ${placeholders}${suffix}`, batch.flat());
  }
}
async function persistEvaluationIndex(connection, evaluation) {
  const versions = new Map(evaluation.catalogVersions.map(ref => [ref.id, ref.version]));
  // Preserve the former sequential upsert semantics if a legacy payload happens
  // to repeat an ID: the last result and its evidence are the persisted ones.
  const results = [...new Map(evaluation.results.map(result => [result.variableId, result])).values()];
  await insertRows(connection,
    'INSERT INTO evaluation_results (evaluation_id, variable_id, catalog_version, status, value_json, reason)',
    results.map(result => [evaluation.id, result.variableId, versions.get(result.variableId), result.status,
      result.value === undefined ? null : JSON.stringify(result.value), result.reason ?? null]),
    ' ON DUPLICATE KEY UPDATE catalog_version = VALUES(catalog_version), status = VALUES(status), value_json = VALUES(value_json), reason = VALUES(reason)');
  // Only replace evidence for variables in this payload. Historical variables
  // omitted from an update and every other evaluation remain untouched.
  for (const batch of rowBatches(results.map(result => [result.variableId]))) {
    await connection.execute(`DELETE FROM evaluation_evidence WHERE evaluation_id = ? AND variable_id IN (${batch.map(() => '?').join(', ')})`, [evaluation.id, ...batch.flat()]);
  }
  await insertRows(connection,
    'INSERT INTO evaluation_evidence (evaluation_id, variable_id, source_message_id, quote)',
    results.flatMap(result => (result.evidence || []).map(evidence => [evaluation.id, result.variableId, evidence.messageId, evidence.quote])));
}
function emptyState() {
  const state = createState(false);
  for (const key of Object.keys(tables)) state[key] = [];
  // This is only a read scaffold. A fresh seed's marker must not claim that
  // a persisted legacy database has already received the catalog migration.
  delete state.metadata.catalogRevision;
  return state;
}
export class MysqlStore {
  constructor(options) { this.pool = mysql.createPool(options); }
  async load(connection) {
    const state = emptyState();
    for (const [key, table] of Object.entries(tables)) {
      const [rows] = await connection.query(`SELECT payload FROM ${table} ORDER BY sequence_id`);
      state[key] = rows.map(row => decode(row.payload));
    }
    const [settings] = await connection.query('SELECT id, payload FROM portal_settings');
    for (const row of settings) state[row.id] = decode(row.payload);
    return state;
  }
  async read() {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const state = await this.load(connection);
      await connection.commit(); return state;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async transaction(fn) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE');
      const previous = await this.load(connection);
      const draft = structuredClone(previous);
      const result = await fn(draft);
      for (const [key, table] of Object.entries(tables)) {
        const before = new Map(previous[key].map(item => [item.id, JSON.stringify(item)]));
        const after = new Set(draft[key].map(item => item.id));
        for (const item of draft[key]) {
          const payload = JSON.stringify(item);
          if (before.get(item.id) === payload) continue;
          if (key === 'users') await connection.execute('INSERT INTO users (id, email, payload) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)', [item.id, item.email.toLowerCase(), payload]);
          else await connection.execute(`INSERT INTO ${table} (id, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)`, [item.id, payload]);
          if (key === 'evaluations') await persistEvaluationIndex(connection, item);
        }
        // Solo las sesiones expiran o se eliminan; el histórico es acumulativo.
        if (key === 'sessions') for (const id of before.keys()) if (!after.has(id)) await connection.execute('DELETE FROM sessions WHERE id = ?', [id]);
      }
      for (const key of ['settings', 'metadata']) if (JSON.stringify(previous[key]) !== JSON.stringify(draft[key])) await connection.execute('INSERT INTO portal_settings (id, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)', [key, JSON.stringify(draft[key])]);
      await connection.commit(); return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async close() { await this.pool.end(); }
}

export class AtomHistoryStore {
  constructor(base, reader) { this.base = base; this.reader = reader; }
  async read() { return this.base.read(); }
  async readWithConversations({ fresh = false } = {}) {
    const [state, source] = await Promise.all([this.base.read(), this.reader.read({ fresh })]);
    return this.attach(state, source);
  }
  attach(state, source) {
    ensureEvaluationState(state);
    const latest = new Map();
    for (const evaluation of state.evaluations.filter(e => e.purpose !== 'comparison' && !e.taskId)) {
      const previous = latest.get(evaluation.conversationId);
      if (!previous || evaluation.createdAt >= previous.createdAt) latest.set(evaluation.conversationId, evaluation);
    }
    state.conversations = source.conversations.map(conversation => ({ ...conversation, evaluationId: state.operationalRefs.find(r => r.id === conversation.id)?.evaluationId || latest.get(conversation.id)?.id || null }));
    state.countries = source.countries;
    state.metadata = { ...state.metadata, source: 'Atom', lastLoadedAt: source.loadedAt };
    return state;
  }
  async transaction(fn) { return this.base.transaction(fn); }
  async transactionWithConversations(fn) {
    const source = await this.reader.read({ fresh: true });
    return this.base.transaction(state => fn(this.attach(state, source)));
  }
  async close() { await Promise.all([this.base.close(), this.reader.close()]); }
}
