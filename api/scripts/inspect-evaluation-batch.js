import { pathToFileURL } from 'node:url';
import { evaluationBatchAudit } from '../src/evaluation-batch-audit.js';
import { AppError } from '../src/errors.js';

const safeCodes = new Set(['INVALID_ARGUMENTS', 'AUDIT_CONFIGURATION', 'AUDIT_JOB_NOT_FOUND', 'DUPLICATE_BATCH',
  'AUDIT_SCOPE_MISMATCH', 'AUDIT_RESULT_MISMATCH', 'AUDIT_SOURCE_DUPLICATE', 'INVALID_AUDIT_TIME', 'MISSING_CATALOG_VERSION']);
const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const fail = code => { throw new AppError(409, 'No se pudo obtener el diagnóstico agregado. No se modificaron datos.', code); };

export function parseArguments(args) {
  if (args.length !== 2 || args[0] !== '--job-id' || !validId(args[1])) fail('INVALID_ARGUMENTS');
  return args[1];
}

export const safeAuditFailure = error => ({ success: false, readOnly: true,
  errorCode: safeCodes.has(error?.code) ? error.code : 'AUDIT_FAILED',
  message: 'No se pudo obtener el diagnóstico agregado. No se modificaron datos.' });

// Uses only the read interface: no registry, provider calls, transaction,
// recovery, worker inspection, or changes to the operational references.
export async function inspectEvaluationBatch(store, jobId, observedAt) {
  if (!validId(jobId)) fail('INVALID_ARGUMENTS');
  const initial = await store.read();
  const jobs = initial.jobs.filter(job => job.id === jobId);
  if (!jobs.length) fail('AUDIT_JOB_NOT_FOUND');
  if (jobs.length !== 1) fail('DUPLICATE_BATCH');
  const job = jobs[0];
  if (job.purpose !== 'operational' || job.mode !== 'dual' || !Array.isArray(job.conversationIds)
    || !job.conversationIds.length || !Array.isArray(job.modelProfiles) || job.modelProfiles.length !== 2) fail('AUDIT_SCOPE_MISMATCH');
  const scope = { jobId, conversationIds: structuredClone(job.conversationIds), profiles: structuredClone(job.modelProfiles) };
  const state = await store.readWithConversations({ fresh: true, conversationIds: scope.conversationIds });
  return { readOnly: true, ...evaluationBatchAudit(state, scope, observedAt) };
}

async function main(args) {
  // Validate before importing configuration, opening databases, or reading .env.
  const jobId = parseArguments(args);
  const { config, databaseConfig, atomDatabaseConfig } = await import('../src/config.js');
  const db = databaseConfig(), atom = atomDatabaseConfig();
  if (config.demo || !db || !atom) fail('AUDIT_CONFIGURATION');
  const { MysqlStore, AtomHistoryStore } = await import('../src/store.js');
  const { AtomReader } = await import('../src/atom.js');
  const store = new AtomHistoryStore(new MysqlStore(db), new AtomReader(atom, config.timezone));
  try { console.log(JSON.stringify(await inspectEvaluationBatch(store, jobId), null, 2)); }
  finally { await store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify(safeAuditFailure(error)));
  process.exitCode = 1;
});
