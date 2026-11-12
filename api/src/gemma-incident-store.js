import { MysqlStore } from './store.js';
import { RECOVERY_JOBS, RECOVERY_ID } from './gemma-incident-recovery.js';
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;

// Only the isolated incident worker uses this store. Transactions retain the
// normal global app lock and append-only persistence; unrelated records are
// never loaded into the draft or rewritten. All jobs remain visible to guards.
export class GemmaIncidentStore extends MysqlStore {
  constructor(options, plan) {
    super(options);
    if (plan?.id !== RECOVERY_ID || !plan.conversationIds?.length || !Array.isArray(plan.completed)) throw new Error('INVALID_INCIDENT_SCOPE');
    this.plan = structuredClone(plan);
  }
  async load(connection) {
    const state = await super.load(connection, ['catalog', 'catalogVersions', 'jobs', 'modelPolicies']);
    const read = async (key, table, column, ids) => {
      if (!ids.length) { state[key] = []; return; }
      const [rows] = await connection.query(`SELECT payload FROM ${table} WHERE ${column} IN (${ids.map(() => '?').join(',')}) ORDER BY sequence_id`, ids);
      state[key] = rows.map(row => decode(row.payload));
    };
    await read('tasks', 'evaluation_tasks', "JSON_UNQUOTE(JSON_EXTRACT(payload,'$.jobId'))", RECOVERY_JOBS);
    await read('attempts', 'evaluation_attempts', "JSON_UNQUOTE(JSON_EXTRACT(payload,'$.jobId'))", RECOVERY_JOBS);
    await read('operationalRefs', 'operational_refs', 'id', this.plan.conversationIds);
    const evaluationIds = [...new Set([...state.tasks.map(t => t.evaluationId), ...state.operationalRefs.map(r => r.evaluationId),
      ...this.plan.completed.map(r => r.evaluationId)].filter(Boolean))];
    await read('evaluations', 'evaluations', 'id', evaluationIds);
    return state;
  }
}
