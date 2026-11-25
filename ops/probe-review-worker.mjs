import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseSourceProbeArguments, sourceProbeCase, readSourceProbe } from './probe-review-source.mjs';
import { readProbeRequest, sanitizedUpstreamError, probeErrorDiagnostic } from '../api/scripts/probe-review-models.js';
import { assertFreshReviewSources } from '../api/src/fresh-review-run.js';
import { runtimeConfiguration } from '../api/src/automation-configuration.js';
import { registryFromEnv } from '../api/src/model-registry.js';
import { evaluationValidationFeedback } from '../api/src/evaluator.js';
import { digest, sourceFingerprint } from '../api/src/evaluation-context.js';
import { startEvaluationBatch } from '../api/src/evaluation-service.js';
import { createState } from '../api/src/data/seed.js';
import { AppError } from '../api/src/errors.js';

const fail = code => { throw new AppError(409, 'No se pudo completar el diagnóstico privado.', code); };
const models = ['clef-flash', 'gemma-4-26b-a4b-it-mlx'];
const operations = ['GET /v1/models', 'GET /api/v1/models', 'POST /v1/chat/completions', 'POST /v1/systemone'];
const keywords = ['anyOf', 'oneOf', 'allOf', 'const', 'enum', 'type', 'properties', 'additionalProperties', 'required',
  '$ref', '$defs', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'min_repeat', 'max_repeat', 'strict'];

export function createWorkerProbeFetch({ fetchImpl = fetch, redactions = [], maxRequests = 32 } = {}) {
  if (![32, 192].includes(maxRequests)) fail('INVALID_ARGUMENTS');
  const requests = [];
  let blockedRequests = 0;
  const observedFetch = async (url, options) => {
    if (requests.length >= maxRequests) { blockedRequests++; throw new Error('WORKER_PROBE_REQUEST_LIMIT'); }
    let request;
    try { request = JSON.parse(options.body); } catch { fail('AI_CONFIGURATION'); }
    const operation = `${request.method} ${request.path}`;
    if (options.method !== 'POST' || !operations.includes(operation)) fail('AI_CONFIGURATION');
    const schema = request.body?.response_format?.json_schema?.schema, serialized = schema ? JSON.stringify(schema) : '';
    const entry = { number: requests.length + 1, operation, model: models.includes(request.body?.model) ? request.body.model : null,
      requestBodyHash: digest(request.body), requestEnvelopeHash: digest(request),
      envelopeKeys: ['method', 'path', 'query', 'body', 'timeout_ms', 'portal_key', 'caller'].filter(key => Object.hasOwn(request, key)),
      schemaHash: schema ? digest(schema) : null,
      schemaKeywords: keywords.filter(keyword => serialized.includes(`"${keyword}"`)),
      responseFormat: ['json_schema', 'json_object'].includes(request.body?.response_format?.type) ? request.body.response_format.type : null,
      startedAt: new Date().toISOString(), httpStatus: null, upstreamStatus: null, returnedModel: null, technicalError: null };
    requests.push(entry);
    const started = Date.now();
    let response;
    try { response = await fetchImpl(url, options); }
    catch (error) { entry.durationMs = Date.now() - started; entry.transportFailure = true; throw error; }
    entry.httpStatus = response.status;
    try {
      const reader = response.clone().body.getReader(), decoder = new TextDecoder();
      let text = '', size = 0, truncated = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 128 * 1024) { truncated = true; void reader.cancel(); break; }
        text += decoder.decode(value, { stream: true });
      }
      if (!truncated) {
        const body = JSON.parse(text + decoder.decode());
        if (Number.isInteger(body?.upstream_status_code) && body.upstream_status_code >= 100 && body.upstream_status_code <= 599) entry.upstreamStatus = body.upstream_status_code;
        if (typeof body?.response?.model === 'string' && /^(?:clef-flash|gemma-4-26b-a4b-it-mlx)(?::\d+)?$/.test(body.response.model)) entry.returnedModel = body.response.model;
        if (!response.ok || body?.ok === false || entry.upstreamStatus >= 400) {
          const error = body?.response?.error ?? body?.error
            ?? (typeof body?.response === 'string' || typeof body?.response?.message === 'string' ? body.response : undefined);
          entry.technicalError = sanitizedUpstreamError(error, redactions);
          entry.errorHash = error === undefined ? null : digest(error);
        }
      } else entry.bodyInspection = 'size-limit';
    } catch { entry.bodyInspection = 'unavailable'; }
    entry.durationMs = Date.now() - started;
    return response;
  };
  return { fetchImpl: observedFetch, report: () => ({ requests: structuredClone(requests), networkCalls: requests.length, maxNetworkRequests: maxRequests, blockedRequests }) };
}

class WorkerProbeMemoryStore {
  constructor(state) { this.state = structuredClone(state); this.queue = Promise.resolve(); }
  async read() { await this.queue; return structuredClone(this.state); }
  async readWithConversations({ conversationIds } = {}) {
    const state = await this.read();
    if (conversationIds) state.conversations = state.conversations.filter(item => conversationIds.includes(item.id));
    return state;
  }
  async transaction(fn) {
    const result = this.queue.then(async () => {
      const draft = structuredClone(this.state), value = await fn(draft);
      this.state = draft;
      return structuredClone(value);
    });
    this.queue = result.catch(() => {});
    return result;
  }
}

export async function probeReviewWorker({ manifest, state, source, env = process.env, fetchImpl = fetch }) {
  const member = sourceProbeCase(manifest);
  assertFreshReviewSources(manifest, source.conversations, [member.conversationId]);
  const before = digest(state);
  const observer = createWorkerProbeFetch({ fetchImpl, redactions: [env.AGENT_SHARED_TOKEN, env.GATEWAY_BASE_URL, env.GATEWAY_PORTAL_KEY].filter(Boolean) });
  const registry = registryFromEnv({ demo: false, env, fetchImpl: observer.fetchImpl });
  const runtime = state.settings.automation ? runtimeConfiguration(state.settings.automation) : null;
  const bound = registry.forState(state).withRuntime(runtime);
  const profiles = ['clef-local', 'gemma-local'].map(id => bound.snapshot(bound.resolve(id)));
  if (profiles.some((profile, index) => profile.provider !== 'gateway' || profile.demo || profile.model !== models[index])) fail('AI_CONFIGURATION');
  const isolated = createState(false);
  isolated.settings = structuredClone(state.settings);
  isolated.catalog = structuredClone(state.catalog);
  isolated.catalogVersions = structuredClone(state.catalogVersions);
  isolated.conversations = structuredClone(source.conversations);
  const store = new WorkerProbeMemoryStore(isolated);
  const started = Date.now();
  let error = null, jobId = null;
  try {
    const launch = await startEvaluationBatch(store, registry, {
      purpose: 'comparison', conversationIds: [member.conversationId],
      modelIds: ['clef-local', 'gemma-local'], pendingOnly: false, includeOpen: true, max: 1,
      executionOrder: 'conversation-first', concurrency: 1, runtimeConfiguration: runtime,
      idempotencyKey: `private-worker-probe:${manifest.id}:${randomUUID()}`,
      name: 'Diagnóstico privado de worker · dos modelos',
    });
    jobId = launch.job.id;
    await launch.completion;
  } catch (caught) { error = probeErrorDiagnostic(caught); }
  const current = await store.read();
  const tasks = current.tasks.filter(task => task.jobId === jobId);
  const complete = task => {
    const result = current.evaluations.find(item => item.id === task.evaluationId);
    return task.status === 'completed' && result && !result.partial && !result.error && !result.demo && !result.usedFallback
      && result.model === task.profile.model && result.sourceHash === task.context.sourceHash && result.purpose === 'comparison';
  };
  const attempts = current.attempts.filter(attempt => attempt.jobId === jobId);
  return { phase: 'real-worker-probe', checkedAt: new Date().toISOString(), requestId: manifest.id, country: 'HN',
    sourceHash: sourceFingerprint(source.conversations[0]), sourceVerified: true, messageCount: source.conversations[0].messages.length,
    synthetic: false, published: false, databaseChanged: false, configurationUnchanged: before === digest(state)
      && digest(current.settings) === digest(state.settings), durationMs: Date.now() - started,
    profiles: profiles.map(profile => ({ profileId: profile.id, model: profile.model, configurationHash: profile.configurationHash })),
    runtimeHash: digest(runtime), executionOrder: 'conversation-first', concurrency: 1, expectedTasks: 2,
    tasks: tasks.map(task => ({ profileId: task.profile.id, model: task.profile.model, status: task.status,
      completed: !!complete(task), error: probeErrorDiagnostic(task.error) })),
    attempts: attempts.map(attempt => ({ profileId: ['clef-local', 'gemma-local'].includes(attempt.profileId) ? attempt.profileId : null,
      status: ['completed', 'partial', 'failed', 'running'].includes(attempt.status) ? attempt.status : null,
      durationMs: Number.isFinite(attempt.durationMs) ? attempt.durationMs : null,
      validationErrors: evaluationValidationFeedback(state.catalog, attempt.validationErrors), error: probeErrorDiagnostic(attempt.error) })),
    completed: tasks.length === 2 && tasks.every(complete), ...observer.report(), error };
}

async function main(args) {
  const requestId = parseSourceProbeArguments(args);
  const { config, databaseConfig, atomDatabaseConfig } = await import('../api/src/config.js');
  const { AtomReader } = await import('../api/src/atom.js');
  const mysql = createRequire(new URL('../api/package.json', import.meta.url))('mysql2/promise');
  const db = databaseConfig(), atom = atomDatabaseConfig();
  if (config.demo || !db || !atom) fail('REAL_MODE_REQUIRED');
  const { connectionLimit, ...connectionOptions } = db;
  const connection = await mysql.createConnection(connectionOptions);
  let saved;
  try { saved = await readProbeRequest(connection, requestId); }
  finally { await connection.end(); }
  const reader = new AtomReader(atom, config.timezone), pool = reader.pool;
  let atomConnection, source;
  try {
    atomConnection = await pool.getConnection();
    await atomConnection.query({ sql: 'SET TRANSACTION READ ONLY', timeout: 15000 });
    await atomConnection.query({ sql: 'START TRANSACTION WITH CONSISTENT SNAPSHOT', timeout: 15000 });
    reader.pool = { query: (sql, values = []) => {
      if (!/^SELECT\b/i.test(sql.trim())) fail('PILOT_FAILED');
      return atomConnection.query({ sql, values, timeout: 15000 });
    } };
    source = await readSourceProbe(reader, saved.manifest);
  } finally {
    if (atomConnection) { await atomConnection.rollback().catch(() => {}); atomConnection.release(); }
    reader.pool = pool;
    await reader.close();
  }
  const result = await probeReviewWorker({ ...saved, source });
  console.log(JSON.stringify(result));
  process.exitCode = result.completed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.log(JSON.stringify({ phase: 'real-worker-probe-failed', databaseChanged: false, error: probeErrorDiagnostic(error) }));
    process.exitCode = 2;
  });
}
