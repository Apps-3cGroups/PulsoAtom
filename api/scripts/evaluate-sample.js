import { config, atomDatabaseConfig, databaseConfig } from '../src/config.js';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { AtomReader } from '../src/atom.js';
import { evaluatorFromEnv } from '../src/evaluator.js';
import { runEvaluationBatch } from '../src/evaluation-service.js';

const appDb = databaseConfig();
const atomDb = atomDatabaseConfig();
const evaluator = evaluatorFromEnv();
if (!appDb || !atomDb || !evaluator.configured || process.env.OPENAI_EVALUATION_ENABLED !== 'true') {
  console.error('La muestra requiere APP_DB_*, ATOM_DB_*, OPENAI_* y OPENAI_EVALUATION_ENABLED=true.');
  process.exitCode = 1;
} else {
  const store = new AtomHistoryStore(new MysqlStore(appDb), new AtomReader(atomDb, config.timezone));
  try {
    const sourceJobId = process.argv[2] === '--recheck' ? process.argv[3] : null;
    let options = { max: 5, random: true, pendingOnly: true };
    if (sourceJobId) {
      const source = (await store.read()).jobs.find(j => j.id === sourceJobId);
      if (!source || source.conversationIds.length !== 5) throw new Error('La ejecución original de cinco conversaciones no existe.');
      options = { max: 5, conversationIds: source.conversationIds, pendingOnly: false, sourceJobId };
    }
    const job = await runEvaluationBatch(store, evaluator, options);
    const state = await store.read();
    console.log(JSON.stringify({ jobId: job.id, status: job.status, completed: job.completed, failed: job.failed,
      results: job.conversationIds.map(id => {
        const evaluation = state.evaluations.filter(e => e.conversationId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
        return { conversationId: id, evaluated: !!evaluation,
          alerts: evaluation?.results.filter(r => r.value === 1).map(r => ({ variableId: r.variableId, evidenceIds: r.evidence.map(e => e.messageId) })) || [],
          error: job.errors.find(e => e.conversationId === id)?.message || null };
      }) }, null, 2));
    if (job.failed) process.exitCode = 1;
  } catch (error) { console.error(error.code || error.name, error.message); process.exitCode = 1; }
  finally { await store.close(); }
}
