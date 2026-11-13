import { MysqlStore } from './store.js';
import { RECOVERY_JOBS } from './gemma-incident-recovery.js';
import { assertCompletionPlan, assertCompletionMutation, completionSources, COMPLETION_KEYS } from './tuesday-wednesday-completion.js';
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;

// Scoped worker storage. All jobs remain visible for concurrency guards, while
// answers and attempts outside the explicit cohort never enter a draft.
export class CompletionStore extends MysqlStore {
  constructor(options, plan) {
    super(options); assertCompletionPlan(plan); this.plan = structuredClone(plan); this.recordCache = new Map();
  }
  async load(connection) {
    const state = await super.load(connection, ['catalog', 'catalogVersions', 'jobs', 'modelPolicies']);
    const read = async (key, table, column, ids) => {
      if (!ids.length) { state[key] = []; return; }
      const [rows] = await connection.query(`SELECT id, SHA2(CAST(payload AS CHAR), 256) AS revision FROM ${table} WHERE ${column} IN (${ids.map(() => '?').join(',')}) ORDER BY sequence_id`, ids);
      const values = new Map(), changed = [];
      for (const row of rows) {
        const cached = this.recordCache.get(`${table}:${row.id}`);
        if (cached?.revision === row.revision) values.set(row.id, cached.value); else changed.push(row);
      }
      for (let start = 0; start < changed.length; start += 500) {
        const batch = changed.slice(start, start + 500);
        const [payloads] = await connection.query(`SELECT id, payload FROM ${table} WHERE id IN (${batch.map(() => '?').join(',')})`, batch.map(r => r.id));
        const revisions = new Map(batch.map(r => [r.id, r.revision]));
        for (const row of payloads) {
          const value = decode(row.payload); values.set(row.id, value);
          this.recordCache.set(`${table}:${row.id}`, { revision: revisions.get(row.id), value });
        }
      }
      state[key] = rows.map(row => { if (!values.has(row.id)) throw new Error('COMPLETION_ROW_CHANGED'); return structuredClone(values.get(row.id)); });
    };
    const jobIds = [...RECOVERY_JOBS, ...state.jobs.filter(j => Object.values(COMPLETION_KEYS).includes(j.idempotencyKey)).map(j => j.id)];
    const ids = completionSources(this.plan).map(c => c.id);
    // Include tasks for target IDs as well as old protected tasks. This detects
    // another assignment before first creation instead of silently duplicating it.
    const [foreignTasks] = await connection.query("SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(payload,'$.jobId')) jobId FROM evaluation_tasks WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.conversationId')) IN (" + ids.map(() => '?').join(',') + ')', ids);
    const relevantJobs = [...new Set([...jobIds, ...foreignTasks.map(r => r.jobId)])];
    await read('tasks', 'evaluation_tasks', "JSON_UNQUOTE(JSON_EXTRACT(payload,'$.jobId'))", relevantJobs);
    await read('attempts', 'evaluation_attempts', "JSON_UNQUOTE(JSON_EXTRACT(payload,'$.jobId'))", jobIds);
    await read('operationalRefs', 'operational_refs', 'id', ids);
    // Read all historical answers for selected IDs, not only the current task
    // anchor, so retries cannot overwrite earlier partial answers.
    const [targetEvaluations] = await connection.query("SELECT id FROM evaluations WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.conversationId')) IN (" + ids.map(() => '?').join(',') + ')', ids);
    const evaluationIds = [...new Set([...state.tasks.map(t => t.evaluationId), ...state.operationalRefs.map(r => r.evaluationId),
      ...this.plan.protected.map(r => r.evaluationId), ...targetEvaluations.map(r => r.id)].filter(Boolean))];
    await read('evaluations', 'evaluations', 'id', evaluationIds);
    return state;
  }
  async transaction(fn) {
    return super.transaction(async draft => {
      const before = structuredClone(draft), result = await fn(draft);
      assertCompletionMutation(before, draft, this.plan); return result;
    });
  }
}
