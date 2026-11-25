import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { createState } from './data/seed.js';
import { missingDatabase, databaseError } from './errors.js';
import { copySourceFingerprint, ensureEvaluationState } from './evaluation-context.js';
import { migrateCatalogV5 } from './catalog-v5.js';
import { enableNavigationSummaryCache } from './navigation-cache.js';
import { navigationSummaryProjection, decodeNavigationSummary } from './navigation-projection.js';
import { requireReviewSelection, applyReviewSelection } from './review-selection.js';

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
  async readSettings() { await this.queue; return structuredClone(this.state.settings || {}); }
  async settingsTransaction(fn) { return this.transaction(state => fn(state.settings ||= {})); }
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
  async readSettings() { return {}; }
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
  modelPolicies: 'model_policies', dailyAssignments: 'evaluation_daily_assignments',
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
  async readSettings() {
    const [rows] = await this.pool.execute("SELECT payload FROM portal_settings WHERE id = 'settings'");
    return rows[0] ? decode(rows[0].payload) : {};
  }
  // Reuse the same global lock as evaluation workers, but do not load or write
  // their tables. Fresh settings are merged inside the locked transaction.
  async settingsTransaction(fn) { return this.transaction(state => fn(state.settings ||= {}), []); }
  async readEvaluationConfiguration() {
    return this.readSnapshot(connection => this.load(connection, ['catalog']));
  }
  async loadAutomationAdministration(connection, monitor = false) {
    const state = await this.load(connection, monitor ? [] : ['catalog']);
    // Configuration changes only reconcile automatic/legacy daily jobs. Never
    // transfer historical answers, attempts, evidence or task prompt snapshots.
    const [jobs] = await connection.query(`SELECT payload FROM evaluation_jobs
      WHERE JSON_TYPE(JSON_EXTRACT(payload, '$.automation')) = 'OBJECT'
        OR JSON_TYPE(JSON_EXTRACT(payload, '$.dailyActivity')) = 'OBJECT'
      ORDER BY sequence_id`);
    state.jobs = jobs.map(row => decode(row.payload));
    const [assignments] = await connection.query('SELECT payload FROM evaluation_daily_assignments ORDER BY sequence_id');
    state.dailyAssignments = assignments.map(row => decode(row.payload));
    const ids = [...new Set([
      ...state.jobs.filter(job => monitor || job.automation && job.status !== 'running').map(job => job.id),
      ...(monitor ? state.dailyAssignments.map(row => row.jobId) : []),
    ])];
    const fields = ['id', 'jobId', 'conversationId', 'status', 'nextAttemptAt', 'error'];
    const projection = fields.map(field => `'${field}', JSON_EXTRACT(payload, '$.${field}')`).join(', ');
    for (let offset = 0; offset < ids.length; offset += 300) {
      const batch = ids.slice(offset, offset + 300);
      const [tasks] = await connection.query(`SELECT JSON_OBJECT(${projection},
        'profile', JSON_OBJECT('id', JSON_EXTRACT(payload, '$.profile.id'))) AS payload
        FROM evaluation_tasks WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.jobId')) IN (${batch.map(() => '?').join(',')})
        ORDER BY sequence_id`, batch);
      state.tasks.push(...tasks.map(row => decode(row.payload)));
    }
    return state;
  }
  async evaluationConfigurationTransaction(fn) {
    return this.transaction(async state => {
      const tasks = JSON.stringify(state.tasks);
      const result = await fn(state);
      if (JSON.stringify(state.tasks) !== tasks) throw new Error('Configuration cannot modify projected evaluation tasks.');
      return result;
    }, ['jobs', 'dailyAssignments'], connection => this.loadAutomationAdministration(connection));
  }
  async readAutomationMonitorState() {
    return this.readSnapshot(connection => this.loadAutomationAdministration(connection, true));
  }
  async readAuthentication(sessionId) {
    const [sessions] = await this.pool.execute('SELECT payload FROM sessions WHERE id = ?', [sessionId]);
    const session = sessions[0] && decode(sessions[0].payload);
    if (!session) return { sessions: [], users: [] };
    const [users] = await this.pool.execute('SELECT payload FROM users WHERE id = ?', [session.userId]);
    return { sessions: [session], users: users.map(row => decode(row.payload)) };
  }
  async readUserByEmail(email) {
    const [rows] = await this.pool.execute('SELECT payload FROM users WHERE email = ?', [email.toLowerCase()]);
    return rows[0] && decode(rows[0].payload);
  }
  async authenticationTransaction(fn) { return this.transaction(fn, ['users', 'sessions']); }
  async loadAutomationQueue(connection) {
    const state = await this.load(connection, ['jobs', 'dailyAssignments', 'catalog', 'catalogVersions', 'modelPolicies']);
    // Scheduling needs identity, dependencies and retry state, never model answers.
    const fields = ['id', 'jobId', 'conversationId', 'status', 'nextAttemptAt', 'error', 'round'];
    const projection = fields.map(field => `'${field}', JSON_EXTRACT(payload, '$.${field}')`).join(', ');
    const [rows] = await connection.query(`SELECT JSON_OBJECT(${projection},
      'profile', JSON_OBJECT('id', JSON_EXTRACT(payload, '$.profile.id')),
      'context', JSON_OBJECT('sourceHash', JSON_EXTRACT(payload, '$.context.sourceHash'))) AS payload
      FROM evaluation_tasks ORDER BY sequence_id`);
    state.tasks = rows.map(row => decode(row.payload));
    return state;
  }
  async automationDetectionTransaction(fn) {
    return this.transaction(fn, ['jobs', 'dailyAssignments']);
  }
  async loadEvaluationWorker(connection, jobId) {
    const state = await this.load(connection, ['jobs', 'catalog', 'catalogVersions', 'modelPolicies']);
    for (const key of ['tasks', 'attempts', 'evaluations']) {
      const [rows] = await connection.execute(`SELECT payload FROM ${tables[key]}
        WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.jobId')) = ? ORDER BY sequence_id`, [jobId]);
      state[key] = rows.map(row => decode(row.payload));
    }
    const ids = state.jobs.find(job => job.id === jobId)?.conversationIds || [];
    for (const batch of rowBatches(ids.map(id => [id]))) {
      const [refs] = await connection.execute(`SELECT payload FROM operational_refs WHERE id IN (${batch.map(() => '?').join(',')})`, batch.flat());
      state.operationalRefs.push(...refs.map(row => decode(row.payload)));
    }
    const anchors = [...new Set(state.operationalRefs.map(ref => ref.evaluationId))].filter(id => !state.evaluations.some(e => e.id === id));
    for (const batch of rowBatches(anchors.map(id => [id]))) {
      const [rows] = await connection.execute(`SELECT payload FROM evaluations WHERE id IN (${batch.map(() => '?').join(',')})`, batch.flat());
      state.evaluations.push(...rows.map(row => decode(row.payload)));
    }
    return state;
  }
  evaluationWorker(jobId) {
    const load = connection => this.loadEvaluationWorker(connection, jobId);
    return {
      read: () => this.readSnapshot(load),
      transaction: fn => this.transaction(fn, ['jobs', 'tasks', 'attempts', 'evaluations', 'operationalRefs'], load),
    };
  }
  async readAutomationState() {
    return this.readSnapshot(connection => this.loadAutomationQueue(connection));
  }
  async readSchedulerState() {
    const [jobs, settings, policies] = await Promise.all([
      this.pool.query('SELECT payload FROM evaluation_jobs ORDER BY sequence_id'),
      this.pool.query('SELECT id, payload FROM portal_settings'),
      this.pool.query('SELECT payload FROM model_policies ORDER BY sequence_id'),
    ]);
    return { jobs: jobs[0].map(row => decode(row.payload)), modelPolicies: policies[0].map(row => decode(row.payload)), ...Object.fromEntries(settings[0].map(row => [row.id, decode(row.payload)])) };
  }
  async readNavigation(conversationIds = [], { summaryOnly = false } = {}) {
    // During an online rollout an index may still be waiting for a source transaction.
    // The JSON predicate is equivalent and keeps navigation available until it exists.
    if (!this.navigationColumns || Date.now() - this.navigationColumnsAt > 60000) {
      const [columns] = await this.pool.query("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('evaluations','evaluation_tasks') AND COLUMN_NAME='conversation_key'");
      this.navigationColumns = new Set(columns.map(row => row.TABLE_NAME)); this.navigationColumnsAt = Date.now();
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.beginTransaction();
      const state = emptyState();
      const read = async (key, column, ids) => {
        if (!ids) {
          const [rows] = await connection.query(`SELECT payload FROM ${tables[key]} ORDER BY sequence_id`);
          state[key] = rows.map(row => decode(row.payload)); return;
        }
        for (let offset = 0; offset < ids.length; offset += 10000) {
          const batch = ids.slice(offset, offset + 10000);
          const predicate = column === 'conversation_key' && !this.navigationColumns.has(tables[key]) ? "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.conversationId'))" : column;
          const projection = summaryOnly ? navigationSummaryProjection(key)
            : key === 'tasks' ? "JSON_REMOVE(payload, '$.codeResults')" : 'payload';
          const cacheable = ['evaluations', 'tasks', 'comparisons', 'jobs'].includes(key);
          const fields = cacheable ? 'id, sequence_id, SHA2(CAST(payload AS CHAR), 256) AS revision' : 'sequence_id, payload';
          const [rows] = await connection.query(`SELECT ${fields} FROM ${tables[key]} WHERE ${predicate} IN (${batch.map(() => '?').join(',')}) ORDER BY sequence_id`, batch);
          if (cacheable) {
            this.navigationCache ||= new Map(); this.navigationCacheBytes ||= 0;
            // A summary cache entry must never satisfy a later full detail read.
            const cacheKey = row => `${summaryOnly ? 'summary' : 'full'}:${key}:${row.id}:${row.revision}`;
            const values = new Map(rows.flatMap(row => this.navigationCache.has(cacheKey(row)) ? [[row.id, this.navigationCache.get(cacheKey(row)).value]] : []));
            const missing = rows.filter(row => !values.has(row.id));
            if (missing.length) {
              // Same repeatable-read snapshot as the revision query, including updates
              // to existing task/evaluation IDs. Never trust age or sequence alone.
              const revisions = new Map(missing.map(row => [row.id, row]));
              const payloadBatchSize = summaryOnly ? 250 : missing.length;
              for (let start = 0; start < missing.length; start += payloadBatchSize) {
                const selected = missing.slice(start, start + payloadBatchSize);
                const [fresh] = await connection.query(`SELECT id, ${projection} AS payload FROM ${tables[key]} WHERE id IN (${selected.map(() => '?').join(',')})`, selected.map(row => row.id));
                for (const row of fresh) {
                  const value = summaryOnly ? decodeNavigationSummary(key, decode(row.payload)) : decode(row.payload);
                  const bytes = Buffer.byteLength(JSON.stringify(value));
                  this.navigationRevisions ||= new WeakMap(); this.navigationRevisions.set(value, revisions.get(row.id).revision);
                  values.set(row.id, value);
                  const id = cacheKey(revisions.get(row.id));
                  if (!this.navigationCache.has(id)) { this.navigationCache.set(id, { value, bytes }); this.navigationCacheBytes += bytes; }
                }
              }
              while (this.navigationCacheBytes > 128 * 1024 * 1024) {
                const first = this.navigationCache.keys().next().value;
                this.navigationCacheBytes -= this.navigationCache.get(first).bytes; this.navigationCache.delete(first);
              }
            }
            state[key].push(...rows.map(row => ({ sequence: row.sequence_id, value: values.get(row.id) })));
          } else state[key].push(...rows.map(row => ({ sequence: row.sequence_id, value: decode(row.payload) })));
        }
        state[key] = state[key].sort((a, b) => a.sequence - b.sequence).map(row => row.value);
      };
      for (const key of ['catalog', 'catalogVersions', 'modelPolicies']) await read(key);
      const [settings] = await connection.query('SELECT id, payload FROM portal_settings');
      for (const row of settings) state[row.id] = decode(row.payload);
      const ids = [...new Set(conversationIds)];
      await read('evaluations', 'conversation_key', ids);
      await read('tasks', 'conversation_key', ids);
      await read('operationalRefs', 'id', ids);
      for (const key of ['reviews', 'verdicts']) await read(key, "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.conversationId'))", ids);
      const jobIds = [...new Set([...state.tasks, ...state.evaluations].map(item => item.jobId).filter(Boolean))];
      await read('jobs', 'id', jobIds);
      await read('comparisons', 'id', jobIds);
      await connection.commit();
      return state;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async recordExposures(exposures) {
    const unique = [...new Map(exposures.map(item => [item.id, item])).values()];
    for (let offset = 0; offset < unique.length; offset += 10000) {
      const batch = unique.slice(offset, offset + 10000);
      const [rows] = await this.pool.execute(`SELECT id FROM evaluation_exposures WHERE id IN (${batch.map(() => '?').join(',')})`, batch.map(item => item.id));
      const existing = new Set(rows.map(row => row.id));
      await insertRows(this.pool, 'INSERT IGNORE INTO evaluation_exposures (id, payload)',
        batch.filter(item => !existing.has(item.id)).map(item => [item.id, JSON.stringify(item)]));
    }
  }
  async load(connection, keys = Object.keys(tables)) {
    const state = emptyState();
    for (const key of keys) {
      const table = tables[key];
      const [rows] = await connection.query(`SELECT payload FROM ${table} ORDER BY sequence_id`);
      state[key] = rows.map(row => decode(row.payload));
    }
    const [settings] = await connection.query('SELECT id, payload FROM portal_settings');
    for (const row of settings) state[row.id] = decode(row.payload);
    return state;
  }
  async read() {
    return this.readSnapshot(connection => this.load(connection));
  }
  async readSnapshot(load) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const state = await load(connection);
      await connection.commit(); return state;
    } catch (error) { await connection.rollback(); throw databaseError(error); }
    finally { connection.release(); }
  }
  async transaction(fn, keys = Object.keys(tables), load = connection => this.load(connection, keys)) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE');
      const previous = await load(connection);
      const draft = structuredClone(previous);
      const result = await fn(draft);
      for (const key of keys) {
        const table = tables[key];
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
    } catch (error) { await connection.rollback(); throw databaseError(error); }
    finally { connection.release(); }
  }
  async close() { await this.pool.end(); }
}

export class AtomHistoryStore {
  constructor(base, reader) { this.base = base; this.reader = reader; }
  async read() { return this.base.read(); }
  async readSettings() { return this.base.readSettings ? this.base.readSettings() : (await this.base.read()).settings || {}; }
  async settingsTransaction(fn) { return this.base.settingsTransaction ? this.base.settingsTransaction(fn) : this.base.transaction(state => fn(state.settings ||= {})); }
  async readAuthentication(id) { return this.base.readAuthentication ? this.base.readAuthentication(id) : this.base.read(); }
  async readUserByEmail(email) { return this.base.readUserByEmail ? this.base.readUserByEmail(email) : (await this.base.read()).users.find(u => u.email.toLowerCase() === email.toLowerCase()); }
  async authenticationTransaction(fn) { return this.base.authenticationTransaction ? this.base.authenticationTransaction(fn) : this.base.transaction(fn); }
  async readAutomationState() { return this.base.readAutomationState ? this.base.readAutomationState() : this.base.read(); }
  async automationDetectionTransaction(fn) { return this.base.automationDetectionTransaction ? this.base.automationDetectionTransaction(fn) : this.base.transaction(fn); }
  evaluationWorker(jobId) {
    if (!this.base.evaluationWorker) return this;
    const worker = this.base.evaluationWorker(jobId);
    return { ...worker, readWithConversations: async ({ fresh = false, conversationIds } = {}) => {
      const [state, source] = await Promise.all([worker.read(), this.reader.read({ fresh, ...(conversationIds !== undefined ? { conversationIds } : {}) })]);
      return this.attach(state, source);
    } };
  }
  async readEvaluationConfiguration() { return this.base.readEvaluationConfiguration ? this.base.readEvaluationConfiguration() : this.base.read(); }
  async evaluationConfigurationTransaction(fn) { return this.base.evaluationConfigurationTransaction ? this.base.evaluationConfigurationTransaction(fn) : this.base.transaction(fn); }
  async readAutomationMonitorState() { return this.base.readAutomationMonitorState ? this.base.readAutomationMonitorState() : this.readAutomationState(); }
  async readAutomationSource(options) { return this.reader.readAutomationSource(options); }
  async readCountryCatalog() { return this.reader.readCountryCatalog(); }
  async readSchedulerState() { return this.base.readSchedulerState ? this.base.readSchedulerState() : this.base.read(); }
  async recordExposures(exposures) {
    if (this.base.recordExposures) return this.base.recordExposures(exposures);
    return this.base.transaction(state => { for (const item of exposures) if (!state.exposures.some(e => e.id === item.id)) state.exposures.push(item); });
  }
  async readBootstrap() {
    if (!this.base.readNavigation || !this.reader.readOverview) return this.readWithConversations();
    const [state, source] = await Promise.all([this.base.readNavigation([]), this.reader.readOverview({}, { metadataOnly: true })]);
    return this.attach(state, source);
  }
  async readReviewSelection(id) {
    const metadata = this.base.readNavigation ? await this.base.readNavigation([]) : await this.base.read();
    const selection = requireReviewSelection(metadata, id);
    const conversationIds = selection.cases.map(item => item.conversationId);
    const [state, source] = await Promise.all([
      this.base.readNavigation ? this.base.readNavigation(conversationIds) : Promise.resolve(metadata),
      this.reader.read({ conversationIds }),
    ]);
    // Keep the selected metadata and its members from the same initial read.
    return applyReviewSelection(this.attach({ ...state, reviewSelection: selection }, source), id);
  }
  async readForNavigation(query, { activeOnly = false, summaryOnly = false, now = new Date() } = {}) {
    if (query.reviewSelection) return this.readReviewSelection(query.reviewSelection);
    if (!this.base.readNavigation || !this.reader.readOverview) return this.readWithConversations();
    const scheduling = activeOnly ? await this.readSchedulerState() : null;
    const source = await this.reader.readOverview(query, { activeOnly, settings: scheduling?.settings, now });
    const state = await this.base.readNavigation(source.conversations.map(c => c.id), { summaryOnly: summaryOnly && !query.modelProfileId });
    const evaluatedIds = new Set(state.evaluations.map(e => e.conversationId));
    source.conversations = await this.reader.hydrateOverview(source.conversations, evaluatedIds);
    if (activeOnly) state.jobs = [...new Map([...state.jobs, ...scheduling.jobs].map(j => [j.id, j])).values()];
    const attached = this.attach(state, source);
    this.navigationViewCache ||= new Map();
    enableNavigationSummaryCache(attached, this.navigationViewCache, this.base.navigationRevisions);
    return attached;
  }
  async readIngestionSnapshot(run) { return this.reader.readIngestionSnapshot(run); }
  async readWithConversations({ fresh = false, conversationIds } = {}) {
    const [state, source] = await Promise.all([this.base.read(), this.reader.read({ fresh, ...(conversationIds !== undefined ? { conversationIds } : {}) })]);
    return this.attach(state, source);
  }
  attach(state, source) {
    ensureEvaluationState(state);
    const latest = new Map();
    for (const evaluation of state.evaluations.filter(e => e.purpose !== 'comparison' && !e.taskId)) {
      const previous = latest.get(evaluation.conversationId);
      if (!previous || evaluation.createdAt >= previous.createdAt) latest.set(evaluation.conversationId, evaluation);
    }
    const references = new Map(state.operationalRefs.map(r => [r.id, r.evaluationId]));
    state.conversations = source.conversations.map(conversation => {
      const attached = { ...conversation, evaluationId: references.get(conversation.id) || latest.get(conversation.id)?.id || null };
      copySourceFingerprint(conversation, attached); return attached;
    });
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
