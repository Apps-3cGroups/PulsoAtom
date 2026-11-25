import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseSourceProbeArguments, sourceProbeCase } from './probe-review-source.mjs';
import { createWorkerProbeFetch } from './probe-review-worker.mjs';
import { readProbeRequest, probeErrorDiagnostic } from '../api/scripts/probe-review-models.js';
import { assertFreshReviewSources } from '../api/src/fresh-review-run.js';
import { runtimeConfiguration } from '../api/src/automation-configuration.js';
import { registryFromEnv } from '../api/src/model-registry.js';
import { evaluationValidationFeedback } from '../api/src/evaluator.js';
import { digest } from '../api/src/evaluation-context.js';
import { startEvaluationBatch } from '../api/src/evaluation-service.js';
import { AppError } from '../api/src/errors.js';

const fail = code => { throw new AppError(409, 'No se pudo completar el diagnóstico con bloqueo global.', code); };
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const configurationHash = state => digest({ settings: state.settings, catalog: state.catalog });
const diagnostic = error => ['EVALUATION_RUNNING', 'REVIEW_FOREIGN_JOB_CHANGED', 'REVIEW_SETTINGS_CHANGED', 'REVIEW_WORKER_SCOPE_CHANGED', 'REVIEW_REUSE_FORBIDDEN'].includes(error?.code)
  ? { code: error.code, message: 'El diagnóstico respetó el bloqueo y los límites de escritura de producción.' } : probeErrorDiagnostic(error);

// Uses MysqlStore.transaction: app_lock FOR UPDATE and the persisted running-job
// guard are shared with the production scheduler. Only this comparison is written.
export function createLockedProbeStore({ base, reader, manifest, state: prepared, idempotencyKey }) {
  const member = sourceProbeCase(manifest), expectedConfiguration = configurationHash(prepared);
  let jobId = null;
  const load = async connection => {
    const state = await base.loadEvaluationWorker(connection, jobId || `locked-probe-bootstrap:${manifest.id}`);
    state.comparisons = jobId ? (await connection.execute('SELECT payload FROM comparison_samples WHERE id = ?', [jobId]))[0].map(row => decode(row.payload)) : [];
    return state;
  };
  const check = state => { if (configurationHash(state) !== expectedConfiguration) fail('REVIEW_CONFIGURATION_CHANGED'); };
  const read = async () => { const state = await base.readSnapshot(load); check(state); return state; };
  return {
    get jobId() { return jobId; }, read,
    async readWithConversations({ conversationIds = [member.conversationId] } = {}) {
      if (conversationIds.length !== 1 || conversationIds[0] !== member.conversationId) fail('REVIEW_SOURCE_SCOPE_CHANGED');
      const [state, source] = await Promise.all([read(), reader.read({ fresh: true, conversationIds })]);
      assertFreshReviewSources(manifest, source.conversations, conversationIds);
      state.conversations = source.conversations;
      return state;
    },
    async transaction(fn) {
      let nextJobId = jobId;
      const result = await base.transaction(async state => {
        check(state);
        const settings = JSON.stringify(state.settings), metadata = JSON.stringify(state.metadata), refs = JSON.stringify(state.operationalRefs);
        const foreignJobs = new Map(state.jobs.filter(job => job.id !== jobId).map(job => [job.id, JSON.stringify(job)]));
        const foreignEvaluations = new Map(state.evaluations.filter(item => item.jobId !== jobId).map(item => [item.id, JSON.stringify(item)]));
        const result = await fn(state);
        const added = state.jobs.filter(job => job.id !== jobId && !foreignJobs.has(job.id));
        if (!jobId) {
          const job = added[0];
          if (added.length !== 1 || job.purpose !== 'comparison' || job.idempotencyKey !== idempotencyKey
            || job.conversationIds.length !== 1 || job.conversationIds[0] !== member.conversationId
            || job.total !== 2 || job.automation || job.dailyActivity || job.oneOffRun) fail('REVIEW_WORKER_SCOPE_CHANGED');
          nextJobId = job.id;
          if (state.tasks.length !== 2 || state.tasks.some(task => task.evaluationId || task.profileStates || task.status !== 'pending')) fail('REVIEW_REUSE_FORBIDDEN');
        } else if (added.length) fail('REVIEW_WORKER_SCOPE_CHANGED');
        if (state.jobs.some(job => foreignJobs.has(job.id) && foreignJobs.get(job.id) !== JSON.stringify(job))) fail('REVIEW_FOREIGN_JOB_CHANGED');
        if (settings !== JSON.stringify(state.settings) || metadata !== JSON.stringify(state.metadata)
          || refs !== JSON.stringify(state.operationalRefs)) fail('REVIEW_SETTINGS_CHANGED');
        if (state.tasks.some(task => task.jobId !== nextJobId || task.conversationId !== member.conversationId)
          || state.attempts.some(attempt => attempt.jobId !== nextJobId)
          || state.comparisons.some(item => item.id !== nextJobId || item.jobId !== nextJobId)
          || state.evaluations.some(item => item.jobId !== nextJobId && foreignEvaluations.get(item.id) !== JSON.stringify(item))) fail('REVIEW_WORKER_SCOPE_CHANGED');
        return result;
      }, ['jobs', 'tasks', 'attempts', 'evaluations', 'comparisons'], load);
      jobId = nextJobId;
      return result;
    },
  };
}

export async function runLockedReviewProbe({ base, reader, manifest, state, env = process.env, fetchImpl = fetch }) {
  const member = sourceProbeCase(manifest);
  const observer = createWorkerProbeFetch({ fetchImpl, redactions: [env.AGENT_SHARED_TOKEN, env.GATEWAY_BASE_URL, env.GATEWAY_PORTAL_KEY].filter(Boolean) });
  const registry = registryFromEnv({ demo: false, env, fetchImpl: observer.fetchImpl });
  const runtime = state.settings.automation ? runtimeConfiguration(state.settings.automation) : null;
  const bound = registry.forState(state).withRuntime(runtime);
  const profiles = ['clef-local', 'gemma-local'].map(id => bound.snapshot(bound.resolve(id)));
  if (profiles.some((profile, index) => profile.provider !== 'gateway' || profile.demo
    || profile.model !== ['clef-flash', 'gemma-4-26b-a4b-it-mlx'][index])) fail('AI_CONFIGURATION');
  const idempotencyKey = `locked-worker-probe:${manifest.id}:${randomUUID()}`;
  const store = createLockedProbeStore({ base, reader, manifest, state, idempotencyKey });
  const started = Date.now();
  let error = null;
  try {
    const launch = await startEvaluationBatch(store, registry, {
      purpose: 'comparison', conversationIds: [member.conversationId], modelIds: ['clef-local', 'gemma-local'],
      pendingOnly: false, includeOpen: true, max: 1, executionOrder: 'conversation-first', concurrency: 1,
      runtimeConfiguration: runtime, idempotencyKey, name: 'Diagnóstico de carga · exclusión global · HN',
    });
    await launch.completion;
  } catch (caught) { error = diagnostic(caught); }
  const current = await store.read();
  const tasks = current.tasks.filter(task => task.jobId === store.jobId);
  const complete = task => {
    const result = current.evaluations.find(item => item.id === task.evaluationId);
    return task.status === 'completed' && result && !result.partial && !result.error && !result.demo && !result.usedFallback
      && result.model === task.profile.model && result.sourceHash === task.context.sourceHash && result.purpose === 'comparison';
  };
  return { phase: 'locked-worker-probe', checkedAt: new Date().toISOString(), requestId: manifest.id, country: 'HN',
    sourceHash: member.currentSourceHash, messageCount: member.messageCount, globalWorkerGuard: 'mysql-app-lock-and-running-job',
    comparisonSaved: !!store.jobId, operationalReferencesChanged: false, settingsChanged: false,
    jobId: store.jobId, durationMs: Date.now() - started, expectedTasks: 2,
    profiles: profiles.map(profile => ({ profileId: profile.id, model: profile.model, configurationHash: profile.configurationHash })),
    tasks: tasks.map(task => ({ profileId: task.profile.id, status: task.status, completed: !!complete(task), error: probeErrorDiagnostic(task.error) })),
    attempts: current.attempts.filter(attempt => attempt.jobId === store.jobId).map(attempt => ({
      profileId: ['clef-local', 'gemma-local'].includes(attempt.profileId) ? attempt.profileId : null,
      validationErrors: evaluationValidationFeedback(state.catalog, attempt.validationErrors), error: probeErrorDiagnostic(attempt.error) })),
    completed: tasks.length === 2 && tasks.every(complete), ...observer.report(), error };
}

async function main(args) {
  const requestId = parseSourceProbeArguments(args);
  const { config, databaseConfig, atomDatabaseConfig } = await import('../api/src/config.js');
  const { MysqlStore } = await import('../api/src/store.js');
  const { AtomReader } = await import('../api/src/atom.js');
  const db = databaseConfig(), atom = atomDatabaseConfig();
  if (config.demo || !db || !atom) fail('REAL_MODE_REQUIRED');
  const base = new MysqlStore(db), reader = new AtomReader(atom, config.timezone);
  try {
    const connection = await base.pool.getConnection();
    let saved;
    try { saved = await readProbeRequest(connection, requestId); }
    finally { connection.release(); }
    const result = await runLockedReviewProbe({ base, reader, ...saved });
    console.log(JSON.stringify(result));
    process.exitCode = result.completed ? 0 : 1;
  } finally { await reader.close(); await base.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.log(JSON.stringify({ phase: 'locked-worker-probe-failed', error: diagnostic(error) }));
    process.exitCode = 2;
  });
}
