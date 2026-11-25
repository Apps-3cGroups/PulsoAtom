import { randomUUID } from 'node:crypto';
import { mkdir, chmod, open, writeFile, rename, unlink, readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createState } from '../src/data/seed.js';
import { AppError } from '../src/errors.js';
import { digest } from '../src/evaluation-context.js';
import { evaluationValidationFeedback, supportsAiVariable } from '../src/evaluator.js';
import { runtimeConfiguration } from '../src/automation-configuration.js';
import { registryFromEnv } from '../src/model-registry.js';
import { gemmaContractConversation } from '../src/gemma-contract-check.js';
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
  'PILOT_COUNTRIES_REQUIRED', 'PILOT_ALREADY_RUNNING', 'PILOT_RESULTS_INVALID', 'PILOT_CONFIGURATION_CHANGED',
  'PILOT_REPORT_NOT_FOUND', 'PILOT_REPORT_INVALID']);
const publicCode = error => safeCodes.has(error?.code) ? error.code : 'PILOT_FAILED';
const query = async (connection, sql, values = []) => (await connection.query({ sql, values, timeout: 15000 }))[0];

export function parseProbeArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  let requestId, mode = 'check', explicitMode = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--request-id' && requestId === undefined) requestId = args[++i];
    else if (['--check', '--run', '--report-only', '--probe-rejection'].includes(args[i]) && !explicitMode) { mode = args[i].slice(2); explicitMode = true; }
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

const knownErrorMessages = new Set([
  'Falta configurar el modelo local y su herramienta en el Gateway.',
  'Falta configurar la conexión y la identidad de Pulso en el Gateway.',
  'La operación solicitada al Gateway no está admitida por Pulso.',
  'El modelo está deshabilitado o pendiente de configuración.',
  'La configuración del modelo cambió. Crea una nueva ejecución.',
  'El Gateway devolvió una respuesta inválida.',
  'No se pudo contactar el Gateway dentro del tiempo permitido.',
  'La conversación supera el contexto admitido por el modelo. Queda pendiente de revisión.',
  'El modelo no tiene memoria suficiente para esta solicitud. Se requiere reducir el checklist o revisar su capacidad.',
  'El servicio local respondió con un modelo distinto al solicitado. Revisa su configuración.',
  'El modelo local devolvió una respuesta inválida.',
  'El servicio local no informó qué modelo produjo la respuesta.',
  'El modelo local no devolvió una única evaluación.',
  'El modelo no puede evaluar este contenido.',
  'El modelo local no completó la evaluación.',
  'El modelo local devolvió una llamada de herramienta en lugar de una evaluación.',
  'El modelo local no devolvió una evaluación estructurada.',
  'El modelo local no devolvió el JSON requerido.',
  'El modelo local no devolvió el objeto de evaluación requerido.',
  'No se pudo completar una etapa del adaptador.',
  'Resultado estructurado incompleto o duplicado.',
  'Hay variables pendientes de respuesta válida.',
]);
export function probeErrorDiagnostic(error) {
  if (!error) return null;
  const match = typeof error.message === 'string'
    && /^El Gateway rechazó la solicitud al modelo local \(HTTP ([1-5]\d{2})\)\.$/.exec(error.message);
  const explicit = error.details?.upstreamStatus ?? error.upstreamStatus;
  const savedStatus = Number.isInteger(explicit) && explicit >= 100 && explicit <= 599 ? explicit : null;
  const messageStatus = match ? Number(match[1]) : null;
  const statusConflict = savedStatus !== null && messageStatus !== null && savedStatus !== messageStatus;
  const count = typeof error.message === 'string' && /^(\d{1,4}) variables requieren reintento por formato inválido\.$/.exec(error.message);
  const message = match ? `El Gateway rechazó la solicitud al modelo local (HTTP ${messageStatus}).`
    : knownErrorMessages.has(error.message) ? error.message
      : count ? `${Number(count[1])} variables requieren reintento por formato inválido.` : 'Mensaje omitido: no corresponde a una plantilla técnica conocida.';
  return { code: publicCode(error), upstreamStatus: statusConflict ? null : savedStatus ?? messageStatus,
    upstreamStatusSource: statusConflict ? 'conflicting-saved-fields' : savedStatus !== null ? 'saved-field' : messageStatus !== null ? 'known-saved-message' : 'not-saved',
    message, messageRedacted: !match && !knownErrorMessages.has(error.message) && !count };
}

export function sanitizedProbeReport(artifact, requestId) {
  if (!artifact || artifact.schemaVersion !== 1 || artifact.privateDiagnostic !== true
    || artifact.summary?.requestId !== requestId || !Array.isArray(artifact.attempts) || !Array.isArray(artifact.tasks)
    || !Array.isArray(artifact.sources)) fail('PILOT_REPORT_INVALID');
  const profile = value => ['clef-local', 'gemma-local'].includes(value) ? value : null;
  const model = value => ['clef-flash', 'gemma-4-26b-a4b-it-mlx'].includes(value) ? value : null;
  const status = value => ['pending', 'running', 'completed', 'partial', 'failed', 'interrupted'].includes(value) ? value : null;
  const variableId = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,159}$/.test(value);
  const listIds = values => Array.isArray(values) ? [...new Set(values.filter(variableId))] : [];
  const countryByConversation = new Map(artifact.sources.filter(item => countries.includes(item.country)).map(item => [item.conversationId, item.country]));
  const tasks = new Map(artifact.tasks.map(task => [task.id, task]));
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ? value : null;
  const number = value => Number.isFinite(value) && value >= 0 ? value : null;
  return { phase: 'report-only', requestId, databaseChanged: false, inferenceExecuted: false,
    artifactHash: digest(artifact), recordedAt: timestamp(artifact.summary.checkedAt),
    recordedPassed: artifact.summary.passed === true, recordedCompleted: number(artifact.summary.completed),
    models: (Array.isArray(artifact.summary.byModel) ? artifact.summary.byModel : []).map(item => ({
      profileId: profile(item.profileId), model: model(item.model), total: number(item.total),
      completed: number(item.completed), partial: number(item.partial), failed: number(item.failed) })),
    tasks: artifact.tasks.map(task => ({ country: countryByConversation.get(task.conversationId) || null,
      profileId: profile(task.profile?.id), status: status(task.status), error: probeErrorDiagnostic(task.error) })),
    attempts: artifact.attempts.map(attempt => ({
      country: countryByConversation.get(tasks.get(attempt.taskId)?.conversationId) || null,
      profileId: profile(attempt.profileId), requestedModel: model(attempt.requestedModel), actualModel: model(attempt.actualModel),
      status: status(attempt.status), startedAt: timestamp(attempt.startedAt), finishedAt: timestamp(attempt.finishedAt),
      durationMs: number(attempt.durationMs), variableIds: listIds(attempt.variableIds), validVariableIds: listIds(attempt.validVariableIds),
      validationErrors: evaluationValidationFeedback(listIds(attempt.variableIds).map(id => ({ id })), attempt.validationErrors),
      error: probeErrorDiagnostic(attempt.error),
    })),
    limitation: 'Only persisted structured errors are available. Raw Gateway/upstream responses were not saved and are never printed.',
  };
}

export async function readPrivateProbeReport(requestId, rootDirectory = fileURLToPath(new URL('../.data/review-runs/', import.meta.url))) {
  if (!slug.test(requestId || '')) fail('INVALID_ARGUMENTS');
  const directory = path.join(rootDirectory, requestId);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') fail('PILOT_REPORT_NOT_FOUND'); throw error; }
  const names = entries.filter(entry => entry.isFile() && /^pilot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9-]{36}\.json$/.test(entry.name))
    .map(entry => entry.name).sort().reverse();
  if (!names.length) fail('PILOT_REPORT_NOT_FOUND');
  const filename = path.join(directory, names[0]), info = await lstat(filename);
  if (!info.isFile() || info.size > 50 * 1024 * 1024) fail('PILOT_REPORT_INVALID');
  let artifact;
  try { artifact = JSON.parse(await readFile(filename, 'utf8')); }
  catch { fail('PILOT_REPORT_INVALID'); }
  return sanitizedProbeReport(artifact, requestId);
}

const schemaKeywords = ['anyOf', 'oneOf', 'allOf', 'const', 'enum', 'type', 'properties', 'additionalProperties',
  'required', '$ref', '$defs', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'min_repeat', 'max_repeat',
  'repeat', 'quantifier', 'size', 'DFA', 'FSM', 'complexity', 'nullable', 'format', 'pattern', 'strict', 'json_schema', 'response_format'];
const technicalWords = new Set(('failed failure error invalid unsupported unrecognized unknown unexpected schema schemas json gbnf grammar grammars '
  + 'convert conversion compile compilation parse parsing build building generate generation predicting prediction '
  + 'not supported support allowed allow implemented implement does do is are was were be being a an the to of for in on with without at '
  + 'and or but only must should cannot can could unable expected found got value values property properties keyword keywords '
  + 'object objects array arrays string strings integer number boolean null true false union unions literal literals '
  + 'constraint constraints constrained decoding model mlx outlines lm studio xgrammar tokenizer response request format '
  + 'schemaerror validationerror valueerror runtimeerror typeerror nested root field fields required missing valid '
  + 'max_tokens context length exceeded limit tokens memory insufficient loaded load available unavailable configuration reasoning '
  + 'response_format json_schema anyof oneof allof const enum type additionalproperties ref defs items minitems maxitems minlength maxlength '
  + 'loading canceled cancelled cancellation interrupted aborted timed timeout stopped due system resources resource guardrail guardrails threshold '
  + 'estimated capacity busy already reached disk space device failed loading request user released unloaded unloading '
  + 'min_repeat max_repeat repeat quantifier size dfa fsm complexity minimum maximum greater less than nullable pattern strict').split(' '));

// Only fixed technical vocabulary survives. Even an upstream error that echoes
// credentials, URLs, prompts or a traceback cannot put that content in stdout.
export function sanitizedUpstreamError(value, redactions = []) {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  let message = typeof value === 'string' ? value : typeof object.message === 'string' ? object.message : '';
  message = message.slice(0, 12000);
  for (const secret of redactions.filter(v => typeof v === 'string' && v.length)) message = message.split(secret).join('[redacted]');
  message = message.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted]').replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[redacted]');
  const found = schemaKeywords.filter(keyword => message.includes(keyword));
  const tokens = message.match(/[A-Za-z_$][A-Za-z0-9_$-]*|\d+|[{}[\]():,.;=<>]/g) || [];
  const safeMessage = tokens.map(token => /^[{}[\]():,.;=<>]$/.test(token) ? token
    : technicalWords.has(token.toLowerCase()) || (/^\d{1,5}$/.test(token) && Number(token) <= 10000) ? token : '[redacted]').join(' ').replace(/(?:\[redacted\]\s*){2,}/g, '[redacted] ').slice(0, 1600);
  const field = (input, allowed) => typeof input === 'string' && allowed.includes(input)
    && !redactions.some(secret => secret && input.includes(secret)) ? input : null;
  return { message: safeMessage || 'Upstream error message unavailable.', messageRedacted: true,
    schemaKeywords: found,
    classification: /(?:schema|grammar|gbnf|outlines|xgrammar|\bDFA\b|\bFSM\b|quantifier)/i.test(message) ? 'schema-or-grammar-rejection'
      : /reasoning/i.test(message) ? 'reasoning-configuration-rejection'
        : /context|tokens/i.test(message) ? 'context-or-token-rejection'
          : /memory/i.test(message) ? 'memory-rejection' : 'unclassified-rejection',
    type: field(object.type, ['invalid_request', 'invalid_request_error', 'server_error', 'validation_error', 'schema_error']),
    code: field(object.code, ['invalid_value', 'invalid_request', 'unsupported_value', 'invalid_json_schema', 'unsupported_schema',
      'model_not_found', 'model_not_loaded', 'context_length_exceeded', 'out_of_memory', 'insufficient_memory']),
    param: field(object.param, ['reasoning', 'model', 'response_format', 'response_format.json_schema', 'response_format.json_schema.schema', 'max_tokens']),
  };
}

export async function probeGemmaRejection({ state, env = process.env, fetchImpl = fetch }) {
  const before = digest(state), redactions = [env.AGENT_SHARED_TOKEN, env.GATEWAY_BASE_URL, env.GATEWAY_PORTAL_KEY].filter(Boolean);
  const active = state.catalog.filter(variable => variable.active && !variable.retired && supportsAiVariable(variable));
  const variables = active.slice(0, 8);
  const descriptor = active.find(variable => variable.type === 'Descriptor');
  if (descriptor && !variables.some(variable => variable.type === 'Descriptor')) variables[variables.length - 1] = descriptor;
  if (!variables.length || variables.some(variable => !/^[a-z][a-z0-9_]{0,159}$/.test(variable.id))) fail('UNSUPPORTED_VARIABLE');
  let networkCalls = 0, blockedAdditionalRequests = 0, transport = null, requestSchema = null;
  const blockedAdditionalOperations = [];
  const observedFetch = async (url, options) => {
    let request;
    try { request = JSON.parse(options.body); } catch { fail('AI_CONFIGURATION'); }
    if (networkCalls >= 1) {
      blockedAdditionalRequests++;
      const operation = `${request.method} ${request.path}`;
      blockedAdditionalOperations.push(['GET /v1/models', 'GET /api/v1/models', 'POST /v1/chat/completions'].includes(operation) ? operation : 'other');
      throw new Error('SYNTHETIC_ONE_REQUEST_LIMIT');
    }
    if (options.method !== 'POST' || request.method !== 'POST' || request.path !== '/v1/chat/completions'
      || request.body?.model !== 'gemma-4-26b-a4b-it-mlx') fail('AI_CONFIGURATION');
    networkCalls++;
    const schema = request.body.response_format?.json_schema?.schema;
    const serialized = schema ? JSON.stringify(schema) : '';
    requestSchema = { responseFormat: request.body.response_format?.type === 'json_schema' ? 'json_schema' : 'json_object',
      schemaHash: schema ? digest(schema) : null, keywords: schemaKeywords.filter(keyword => serialized.includes(`"${keyword}"`)) };
    const response = await fetchImpl(url, options);
    transport = { httpStatus: response.status, upstreamStatus: null, returnedModel: null, error: null };
    try {
      const clone = response.clone(), reader = clone.body.getReader();
      let size = 0, text = '', truncated = false;
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 128 * 1024) { truncated = true; void reader.cancel(); break; }
        text += decoder.decode(value, { stream: true });
      }
      if (!truncated) {
        const body = JSON.parse(text + decoder.decode());
        if (Number.isInteger(body?.upstream_status_code) && body.upstream_status_code >= 100 && body.upstream_status_code <= 599) transport.upstreamStatus = body.upstream_status_code;
        if (typeof body?.response?.model === 'string' && /^gemma-4-26b-a4b-it-mlx(?::\d+)?$/.test(body.response.model)) transport.returnedModel = body.response.model;
        if (!response.ok || body?.ok === false || transport.upstreamStatus >= 400) {
          transport.error = sanitizedUpstreamError(body?.response?.error ?? body?.error
            ?? (typeof body?.response === 'string' || typeof body?.response?.message === 'string' ? body.response : undefined), redactions);
        }
      } else transport.bodyInspection = 'size-limit';
    } catch { transport.bodyInspection = 'unavailable'; }
    return response;
  };
  const runtime = state.settings.automation ? runtimeConfiguration(state.settings.automation) : null;
  const registry = registryFromEnv({ demo: false, env, fetchImpl: observedFetch }).forState(state).withRuntime(runtime);
  const profile = registry.resolve('gemma-local');
  if (profile.provider !== 'gateway' || profile.demo || profile.model !== 'gemma-4-26b-a4b-it-mlx') fail('AI_CONFIGURATION');
  const started = Date.now();
  let error = null, result = null;
  try { result = await profile.evaluator.evaluate(structuredClone(gemmaContractConversation), variables); }
  catch (caught) { error = probeErrorDiagnostic(caught); }
  const feedback = evaluationValidationFeedback(variables, result?.validationErrors);
  return { phase: 'probe-rejection', checkedAt: new Date().toISOString(), synthetic: true, databaseChanged: false,
    source: 'fixed-synthetic-conversation', atomRead: false, published: false, configurationUnchanged: before === digest(state),
    model: 'gemma-4-26b-a4b-it-mlx', profileId: 'gemma-local', configurationHash: registry.snapshot(profile).configurationHash,
    runtimeHash: digest(runtime), responseFormat: profile.evaluator.responseFormat, outputSchemaVersion: profile.evaluator.outputSchemaVersion,
    requestedVariables: variables.map(variable => variable.id), includesDescriptor: variables.some(variable => variable.type === 'Descriptor'),
    durationMs: Date.now() - started, networkCalls, blockedAdditionalRequests, blockedAdditionalOperations, requestSchema, transport,
    validResults: Array.isArray(result?.results) ? result.results.length : 0, validationErrors: feedback,
    completed: !error && result?.model === profile.model && result.results?.length === variables.length && !feedback.length,
    error };
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
    console.log('Uso: node scripts/probe-review-models.js --request-id <slug> [--check|--run|--report-only|--probe-rejection]\n--check sólo lee y valida. --run evalúa seis casos reales con ambos modelos en memoria. --report-only lee el último diagnóstico privado sin consultar bases ni ejecutar modelos. --probe-rejection hace una única petición sintética a Gemma sin consultar Atom.');
    return;
  }
  if (input.mode === 'report-only') {
    console.log(JSON.stringify(await readPrivateProbeReport(input.requestId)));
    return;
  }
  const { config, databaseConfig, atomDatabaseConfig } = await import('../src/config.js');
  const { default: mysql } = await import('mysql2/promise');
  const db = databaseConfig(), atom = atomDatabaseConfig();
  if (config.demo || !db || (input.mode !== 'probe-rejection' && !atom)) fail('REAL_MODE_REQUIRED');
  const { connectionLimit, ...connectionOptions } = db;
  const connection = await mysql.createConnection(connectionOptions);
  let saved;
  try { saved = await readProbeRequest(connection, input.requestId); }
  finally { await connection.end(); }
  if (input.mode === 'probe-rejection') {
    const result = await probeGemmaRejection({ state: saved.state });
    console.log(JSON.stringify({ requestId: input.requestId, ...result }));
    process.exitCode = result.completed ? 0 : 1;
    return;
  }
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
