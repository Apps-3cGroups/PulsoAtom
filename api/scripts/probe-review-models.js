import { randomUUID } from 'node:crypto';
import { mkdir, chmod, open, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createState } from '../src/data/seed.js';
import { AppError } from '../src/errors.js';
import { digest } from '../src/evaluation-context.js';
import { evaluationValidationFeedback } from '../src/evaluator.js';
import { startEvaluationBatch } from '../src/evaluation-service.js';
import { validateFreshReviewManifest, assertFreshReviewSources, freshReviewConfiguration } from '../src/fresh-review-run.js';

const countries = ['HN', 'PA', 'CR', 'SV', 'MX', 'NI'];
const slug = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = code => { throw new AppError(409, 'No se pudo completar el piloto privado.', code); };
const safeCodes = new Set(['INVALID_ARGUMENTS', 'INVALID_REVIEW_REQUEST', 'REVIEW_REQUEST_NOT_FOUND', 'REAL_MODE_REQUIRED',
  'REVIEW_MODELS_CHANGED', 'REVIEW_CONFIGURATION_CHANGED', 'REVIEW_SOURCE_SCOPE_CHANGED', 'SOURCE_CHANGED',
  'EVALUATION_MAINTENANCE', 'AI_CONFIGURATION', 'AI_NOT_CONFIGURED', 'AI_UNAVAILABLE', 'AI_TRANSIENT',
  'INVALID_AI_RESULT', 'AI_INCOMPLETE', 'MODEL_CHANGED', 'MODEL_IDENTITY_UNVERIFIED', 'AI_SAFETY_REFUSAL',
  'UNSUPPORTED_VARIABLE', 'EMPTY_CONVERSATION', 'UNSUPPORTED_INPUT', 'INPUT_CAPACITY_EXCEEDED',
  'INVALID_GATEWAY_CATALOG', 'MODEL_UNAVAILABLE', 'AI_CONTEXT_LIMIT', 'AI_RESOURCE_LIMIT',
  'PILOT_COUNTRIES_REQUIRED', 'PILOT_ALREADY_RUNNING', 'PILOT_RESULTS_INVALID', 'PILOT_CONFIGURATION_CHANGED']);
const publicCode = error => safeCodes.has(error?.code) ? error.code : 'PILOT_FAILED';
const query = async (connection, sql, values = []) => (await connection.query({ sql, values, timeout: 15000 }))[0];

export function parseProbeArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  let requestId, mode = 'check', explicitMode = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--request-id' && requestId === undefined) requestId = args[++i];
    else if (['--check', '--run'].includes(args[i]) && !explicitMode) { mode = args[i].slice(2); explicitMode = true; }
    else fail('INVALID_ARGUMENTS');
  }
  if (!slug.test(requestId || '')) fail('INVALID_ARGUMENTS');
  return { requestId, mode };
}

// The production connection is read-only and closed before any inference starts.
// No production store, task, reference or evaluation is passed to the worker.
export async function readProbeRequest(connection, requestId) {
  if (!slug.test(requestId || '')) fail('INVALID_ARGUMENTS');
  await query(connection, 'SET TRANSACTION READ ONLY');
  await query(connection, 'START TRANSACTION WITH CONSISTENT SNAPSHOT');
  try {
    const rows = await query(connection, 'SELECT id, payload FROM portal_settings WHERE id IN (?, ?, ?)',
      ['settings', 'metadata', `reviewRequest:${requestId}`]);
    const values = new Map(rows.map(row => [row.id, decode(row.payload)]));
    const manifest = values.get(`reviewRequest:${requestId}`);
    if (!manifest) fail('REVIEW_REQUEST_NOT_FOUND');
    validateFreshReviewManifest(manifest);
    if (manifest.id !== requestId || !values.has('settings')) fail('INVALID_REVIEW_REQUEST');
    const state = createState(false);
    state.settings = values.get('settings');
    state.metadata = { ...state.metadata, ...(values.get('metadata') || {}) };
    state.catalog = (await query(connection, 'SELECT payload FROM catalog_items ORDER BY sequence_id')).map(row => decode(row.payload));
    state.catalogVersions = (await query(connection, 'SELECT payload FROM catalog_versions ORDER BY sequence_id')).map(row => decode(row.payload));
    await connection.rollback();
    return { manifest, state };
  } catch (error) { await connection.rollback(); throw error; }
}

export function selectProbeCases(manifest) {
  validateFreshReviewManifest(manifest);
  return countries.map(country => {
    const members = manifest.cases.filter(item => item.country === country);
    const original = members.filter(item => item.selectionOrigin === 'original94');
    const eligible = [...(original.length ? original : members)].sort((a, b) => a.messageCount - b.messageCount
      || a.conversationId.localeCompare(b.conversationId, 'en', { numeric: true }));
    if (!eligible.length) fail('PILOT_COUNTRIES_REQUIRED');
    return structuredClone(eligible[Math.floor(eligible.length / 2)]);
  });
}

export async function readProbeSources(reader, manifest, cases = selectProbeCases(manifest)) {
  const ids = cases.map(item => item.conversationId);
  const source = await reader.read({ fresh: true, conversationIds: ids });
  assertFreshReviewSources(manifest, source.conversations, ids);
  return source;
}

export function prepareProbe({ manifest, state, source, registry }) {
  const cases = selectProbeCases(manifest);
  assertFreshReviewSources(manifest, source.conversations, cases.map(item => item.conversationId));
  const configuration = freshReviewConfiguration(state, registry, manifest);
  const bound = registry.forState(state).withRuntime(configuration.runtime);
  const enabled = bound.list().filter(profile => profile.enabled);
  if (!bound.gatewayConfigured || enabled.length !== 2 || enabled.some(profile => !profile.available || profile.demo
    || profile.provider !== 'gateway' || !manifest.profiles.includes(profile.id))) fail('REVIEW_MODELS_CHANGED');
  const profiles = configuration.profiles.map(profile => ({ ...profile,
    responseFormat: bound.resolve(profile.id).evaluator.responseFormat || null }));
  const plan = { requestId: manifest.id, requestedSelectionHash: manifest.selectionHash,
    pilotSelectionHash: digest({ scope: manifest.scope, cases }), sourceHash: digest(cases.map(item => ({
      country: item.country, conversationId: item.conversationId, sourceHash: item.currentSourceHash,
      sourceDocumentId: item.sourceDocumentId, sourceDocumentHash: item.sourceDocumentHash }))),
    scope: structuredClone(manifest.scope), cases: 6, expectedReviews: 12,
    countries: countries.map(country => ({ country, cases: 1 })),
    catalogHash: configuration.catalogHash, runtimeHash: configuration.runtimeHash, profiles,
    executionOrder: 'conversation-first', concurrency: 1,
    configuredAutomaticRetries: state.settings.automation?.retries ?? null,
    retryPolicy: 'Existing comparison worker: at most two attempts per model task; only missing items are retried.',
    databaseChanged: false, sourceVerified: true };
  return { cases, configuration, plan };
}

class ProbeMemoryStore {
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

function summarizeProbe(state, plan, jobId) {
  const tasks = state.tasks.filter(task => task.jobId === jobId);
  const profiles = new Map(plan.profiles.map(profile => [profile.id, profile]));
  const active = state.catalog.filter(item => item.active && !item.retired).map(item => item.id);
  const complete = task => {
    const result = state.evaluations.find(item => item.id === task.evaluationId), profile = profiles.get(task.profile.id);
    return !!(task.status === 'completed' && result && profile && !result.partial && !result.error && !result.demo
      && !result.usedFallback && !result.validationErrors?.length && result.purpose === 'comparison'
      && result.jobId === jobId && result.taskId === task.id && result.conversationId === task.conversationId
      && result.sourceHash === task.context.sourceHash && result.catalogHash === plan.catalogHash
      && result.profileId === profile.id && result.requestedProfileId === profile.id && result.provider === 'gateway'
      && result.model === profile.model && result.modelConfiguration?.configurationHash === profile.configurationHash
      && Array.isArray(result.results) && new Set(result.results.map(item => item.variableId)).size === result.results.length
      && result.results.length === active.length && active.every(id => result.results.some(item => item.variableId === id
        && !item.error && ['evaluado', 'no_evaluado'].includes(item.status))));
  };
  const completed = tasks.filter(complete);
  const errors = new Map(), rules = new Map();
  for (const task of tasks) {
    if (task.error) { const code = publicCode(task.error); errors.set(code, (errors.get(code) || 0) + 1); }
    if (task.status === 'completed' && !complete(task)) errors.set('PILOT_RESULTS_INVALID', (errors.get('PILOT_RESULTS_INVALID') || 0) + 1);
  }
  const attempts = state.attempts.filter(attempt => attempt.jobId === jobId);
  for (const attempt of attempts) for (const item of evaluationValidationFeedback(state.catalog, attempt.validationErrors)) {
    for (const rule of item.rules) rules.set(rule, (rules.get(rule) || 0) + 1);
  }
  const byModel = plan.profiles.map(profile => ({ profileId: profile.id, model: profile.model,
    total: tasks.filter(task => task.profile.id === profile.id).length,
    completed: completed.filter(task => task.profile.id === profile.id).length,
    partial: tasks.filter(task => task.profile.id === profile.id && task.status === 'partial').length,
    failed: tasks.filter(task => task.profile.id === profile.id && task.status === 'failed').length }));
  return { ...plan, checkedAt: new Date().toISOString(), inferenceExecuted: attempts.length > 0,
    completed: completed.length, expectedReviews: 12, attempts: attempts.length,
    passed: tasks.length === 12 && completed.length === 12 && byModel.every(model => model.total === 6 && model.completed === 6),
    byModel, errors: Object.fromEntries(errors), validationRules: Object.fromEntries(rules),
    bothCompleteCountries: countries.filter(country => {
      const ids = state.conversations.filter(item => item.country === country).map(item => item.id);
      return completed.filter(task => ids.includes(task.conversationId)).length === 2;
    }) };
}

// Every worker write stays inside this fresh in-memory store. This deliberately
// never imports persisted tasks/results, even if the selected cases were reviewed.
export async function runProbe({ manifest, state, source, registry, checkpoint = async () => {}, report = () => {} }) {
  const { cases, configuration, plan } = prepareProbe({ manifest, state, source, registry });
  const isolated = createState(false);
  isolated.settings = structuredClone(state.settings);
  isolated.catalog = structuredClone(state.catalog);
  isolated.catalogVersions = structuredClone(state.catalogVersions);
  isolated.conversations = structuredClone(source.conversations);
  const store = new ProbeMemoryStore(isolated);
  const settingsHash = digest(state.settings);
  let jobId, failure;
  const persist = async () => {
    const current = await store.read();
    const summary = summarizeProbe(current, plan, jobId);
    if (failure) summary.error = failure;
    if (digest(current.settings) !== settingsHash) fail('PILOT_CONFIGURATION_CHANGED');
    await checkpoint({ schemaVersion: 1, privateDiagnostic: true, published: false, databaseChanged: false,
      summary, sources: cases, job: current.jobs.find(job => job.id === jobId) || null,
      evaluations: current.evaluations, tasks: current.tasks, attempts: current.attempts });
    return summary;
  };
  await persist();
  try {
    const launch = await startEvaluationBatch(store, registry, {
      purpose: 'comparison', conversationIds: cases.map(item => item.conversationId),
      modelIds: ['clef-local', 'gemma-local'], pendingOnly: false, includeOpen: true, max: 6,
      executionOrder: 'conversation-first', concurrency: 1, runtimeConfiguration: configuration.runtime,
      idempotencyKey: `private-probe:${manifest.id}:${randomUUID()}`,
      name: 'Piloto privado de seis países · evaluaciones nuevas',
      onProgress: async () => { const summary = await persist(); report({ phase: 'progress', ...summary }); },
    });
    jobId = launch.job.id;
    await launch.completion;
    return await persist();
  } catch (error) { failure = publicCode(error); await persist(); throw error; }
}

export async function privateProbeOutput(requestId, rootDirectory = fileURLToPath(new URL('../.data/review-runs/', import.meta.url))) {
  if (!slug.test(requestId || '')) fail('INVALID_ARGUMENTS');
  const directory = path.join(rootDirectory, requestId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lockPath = path.join(directory, 'pilot.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('PILOT_ALREADY_RUNNING'); throw error; }
  const file = path.join(directory, `pilot-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`);
  return {
    async checkpoint(artifact) {
      const temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify(artifact, null, 2) + '\n', { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
    },
    async close() { await lock.close(); await unlink(lockPath); },
  };
}

async function captureAtom(options, timezone, manifest) {
  const { AtomReader } = await import('../src/atom.js');
  const reader = new AtomReader(options, timezone), pool = reader.pool;
  let connection;
  try {
    connection = await pool.getConnection();
    await query(connection, 'SET TRANSACTION READ ONLY');
    await query(connection, 'START TRANSACTION WITH CONSISTENT SNAPSHOT');
    reader.pool = { query: (sql, values = []) => {
      if (!/^SELECT\b/i.test(sql.trim())) fail('PILOT_FAILED');
      return connection.query({ sql, values, timeout: 15000 });
    } };
    return await readProbeSources(reader, manifest);
  } finally {
    if (connection) { await connection.rollback().catch(() => {}); connection.release(); }
    reader.pool = pool;
    await reader.close();
  }
}

async function main(args) {
  const input = parseProbeArguments(args);
  if (input.help) {
    console.log('Uso: node scripts/probe-review-models.js --request-id <slug> [--check|--run]\n--check sólo lee y valida. --run evalúa seis casos reales con ambos modelos en memoria; guarda diagnóstico privado y no escribe en las bases.');
    return;
  }
  const { config, databaseConfig, atomDatabaseConfig } = await import('../src/config.js');
  const { registryFromEnv } = await import('../src/model-registry.js');
  const { default: mysql } = await import('mysql2/promise');
  const db = databaseConfig(), atom = atomDatabaseConfig();
  if (config.demo || !db || !atom) fail('REAL_MODE_REQUIRED');
  const { connectionLimit, ...connectionOptions } = db;
  const connection = await mysql.createConnection(connectionOptions);
  let saved;
  try { saved = await readProbeRequest(connection, input.requestId); }
  finally { await connection.end(); }
  const source = await captureAtom(atom, config.timezone, saved.manifest);
  const registry = registryFromEnv({ demo: false });
  const { plan } = prepareProbe({ ...saved, source, registry });
  if (input.mode === 'check') {
    console.log(JSON.stringify({ phase: 'check', ...plan, inferenceExecuted: false, configurationReady: true }));
    return;
  }
  const output = await privateProbeOutput(input.requestId);
  try {
    const summary = await runProbe({ ...saved, source, registry, checkpoint: output.checkpoint,
      report: aggregate => console.log(JSON.stringify(aggregate)) });
    console.log(JSON.stringify({ phase: 'finished', ...summary }));
    process.exitCode = summary.passed ? 0 : 1;
  } finally { await output.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.log(JSON.stringify({ phase: 'failed', databaseChanged: false, error: publicCode(error) }));
    process.exitCode = 2;
  });
}
