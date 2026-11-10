import mysql from 'mysql2/promise';

const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const projections = {
  tasks: { table: 'evaluation_tasks', fields: ['id', 'jobId', 'conversationId', 'status'] },
  attempts: { table: 'evaluation_attempts', fields: ['id', 'jobId', 'taskId', 'status', 'finishedAt'] },
  evaluations: { table: 'evaluations', fields: ['id', 'jobId', 'taskId', 'conversationId'] },
};

// Administrative adapter: read only the fields needed for a quota change.
// Full model answers, evidence and prompt snapshots never cross the connection.
export class DailyLimitStore {
  constructor(database, atom) {
    this.pool = mysql.createPool(database);
    this.source = mysql.createPool(atom.connection);
    this.tables = Object.fromEntries(Object.entries(atom.tables).map(([key, value]) => [key, mysql.escapeId(value)]));
  }
  async header(connection) {
    const [[settings]] = await connection.query("SELECT payload FROM portal_settings WHERE id = 'settings'");
    const [jobs] = await connection.query('SELECT payload FROM evaluation_jobs ORDER BY sequence_id');
    return { settings: decode(settings.payload), jobs: jobs.map(row => decode(row.payload)) };
  }
  async readWithConversations() {
    const state = await this.header(this.pool);
    const [conversations] = await this.source.query(`SELECT CAST(c.IdConversacion AS CHAR) AS id, p.ISO_Code2 AS country FROM ${this.tables.conversations} c JOIN ${this.tables.countries} p ON p.CodigoPais = c.CodigoPais`);
    return { ...state, conversations };
  }
  async transaction(fn) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE');
      const before = await this.header(connection);
      for (const [key, { table, fields }] of Object.entries(projections)) {
        const select = fields.map(field => `'${field}', JSON_EXTRACT(payload, '$.${field}')`).join(', ');
        const [rows] = await connection.query(`SELECT JSON_OBJECT(${select}) AS payload FROM ${table}`);
        before[key] = rows.map(row => decode(row.payload));
      }
      const draft = structuredClone(before), result = await fn(draft);
      // The administrative operation may only patch task/attempt status fields.
      // It cannot insert/delete records, rewrite answers, or mutate evaluations.
      if (JSON.stringify(draft.evaluations) !== JSON.stringify(before.evaluations)) throw new Error('Evaluation results must remain unchanged.');
      for (const key of ['jobs', 'tasks', 'attempts']) {
        if (draft[key].length !== before[key].length || draft[key].some((row, index) => row.id !== before[key][index].id)) throw new Error('Record membership must remain unchanged.');
      }
      for (let i = 0; i < draft.jobs.length; i++) {
        if (JSON.stringify(draft.jobs[i]) !== JSON.stringify(before.jobs[i])) {
          await connection.execute('UPDATE evaluation_jobs SET payload = ? WHERE id = ?', [JSON.stringify(draft.jobs[i]), draft.jobs[i].id]);
        }
      }
      for (const key of ['tasks', 'attempts']) {
        const groups = new Map();
        const allowed = key === 'tasks' ? ['status', 'deferredReason', 'deferredAt'] : ['status', 'finishedAt'];
        for (let i = 0; i < draft[key].length; i++) {
          const old = before[key][i], row = draft[key][i];
          const changes = Object.fromEntries(Object.keys(row).filter(field => JSON.stringify(row[field]) !== JSON.stringify(old[field])).map(field => [field, row[field]]));
          if (!Object.keys(changes).length) continue;
          if (Object.keys(changes).some(field => !allowed.includes(field))) throw new Error('Only administrative status fields may change.');
          const patch = JSON.stringify(changes);
          if (!groups.has(patch)) groups.set(patch, []);
          groups.get(patch).push(row.id);
        }
        for (const [patch, ids] of groups) {
          for (let offset = 0; offset < ids.length; offset += 250) {
            const batch = ids.slice(offset, offset + 250);
            await connection.execute(`UPDATE ${projections[key].table} SET payload = JSON_MERGE_PATCH(payload, CAST(? AS JSON)) WHERE id IN (${batch.map(() => '?').join(',')})`, [patch, ...batch]);
          }
        }
      }
      if (JSON.stringify(draft.settings) !== JSON.stringify(before.settings)) {
        await connection.execute("UPDATE portal_settings SET payload = ? WHERE id = 'settings'", [JSON.stringify(draft.settings)]);
      }
      await connection.commit(); return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async close() { await Promise.all([this.pool.end(), this.source.end()]); }
}
