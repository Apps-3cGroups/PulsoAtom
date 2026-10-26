import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { createState } from './data/seed.js';
import { missingDatabase } from './errors.js';

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
};
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
function emptyState() {
  const state = createState(false);
  for (const key of Object.keys(tables)) state[key] = [];
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
          if (key === 'evaluations') {
            const versions = new Map(item.catalogVersions.map(ref => [ref.id, ref.version]));
            for (const result of item.results) {
              await connection.execute('INSERT INTO evaluation_results (evaluation_id, variable_id, catalog_version, status, value_json, reason) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE catalog_version = VALUES(catalog_version), status = VALUES(status), value_json = VALUES(value_json), reason = VALUES(reason)', [item.id, result.variableId, versions.get(result.variableId), result.status, result.value === undefined ? null : JSON.stringify(result.value), result.reason ?? null]);
              await connection.execute('DELETE FROM evaluation_evidence WHERE evaluation_id = ? AND variable_id = ?', [item.id, result.variableId]);
              for (const evidence of result.evidence || []) await connection.execute('INSERT INTO evaluation_evidence (evaluation_id, variable_id, source_message_id, quote) VALUES (?, ?, ?, ?)', [item.id, result.variableId, evidence.messageId, evidence.quote]);
            }
          }
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
