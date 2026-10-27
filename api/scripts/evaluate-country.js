import { config, atomDatabaseConfig, databaseConfig } from '../src/config.js';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { AtomReader } from '../src/atom.js';
import { evaluatorFromEnv } from '../src/evaluator.js';
import { eligibleConversations, runEvaluationBatch } from '../src/evaluation-service.js';

const country = process.argv[2]?.toUpperCase();
const max = Number(process.argv[3] || 10);
const appDb = databaseConfig();
const atomDb = atomDatabaseConfig();
const evaluator = evaluatorFromEnv();

if (!/^[A-Z]{2}$/.test(country || '') || !Number.isInteger(max) || max < 1 || max > 100) {
  console.error('Uso: npm run eval:country -- HN 10');
  process.exitCode = 1;
} else if (!appDb || !atomDb || !evaluator.configured || process.env.OPENAI_EVALUATION_ENABLED !== 'true') {
  console.error('La evaluación requiere APP_DB_*, ATOM_DB_*, OPENAI_* y OPENAI_EVALUATION_ENABLED=true.');
  process.exitCode = 1;
} else {
  const store = new AtomHistoryStore(new MysqlStore(appDb), new AtomReader(atomDb, config.timezone));
  try {
    const state = await store.readWithConversations();
    const pending = eligibleConversations(state, { country });
    if (!pending.length) throw new Error(`No hay conversaciones pendientes y completas de ${country}.`);
    console.log(JSON.stringify({ country, available: pending.length, selected: Math.min(max, pending.length) }));
    const job = await runEvaluationBatch(store, evaluator, { country, max, pendingOnly: true,
      onProgress: ({ conversationId, error }) => console.log(JSON.stringify({ conversationId, status: error ? 'failed' : 'saved' })) });
    console.log(JSON.stringify({ jobId: job.id, country, status: job.status, selected: job.total, saved: job.completed, failed: job.failed, conversationIds: job.conversationIds }, null, 2));
    if (job.failed || job.completed !== Math.min(max, pending.length)) process.exitCode = 1;
  } catch (error) { console.error(error.code || error.name, error.message); process.exitCode = 1; }
  finally { await store.close(); }
}
