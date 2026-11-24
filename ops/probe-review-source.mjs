import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readProbeRequest, selectProbeCases, sanitizedUpstreamError, probeErrorDiagnostic } from '../api/scripts/probe-review-models.js';
import { assertFreshReviewSources } from '../api/src/fresh-review-run.js';
import { runtimeConfiguration } from '../api/src/automation-configuration.js';
import { registryFromEnv } from '../api/src/model-registry.js';
import { supportsAiVariable, evaluationValidationFeedback } from '../api/src/evaluator.js';
import { digest, sourceFingerprint } from '../api/src/evaluation-context.js';
import { AppError } from '../api/src/errors.js';

const fail = code => { throw new AppError(409, 'No se pudo completar el diagnóstico privado.', code); };
const keywords = ['anyOf', 'oneOf', 'allOf', 'const', 'enum', 'type', 'properties', 'additionalProperties', 'required',
  '$ref', '$defs', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'min_repeat', 'max_repeat', 'strict'];

export function parseSourceProbeArguments(args) {
  if (args.length !== 2 || args[0] !== '--request-id' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(args[1])) fail('INVALID_ARGUMENTS');
  return args[1];
}

export function sourceProbeCase(manifest) {
  const member = selectProbeCases(manifest).find(item => item.country === 'HN');
  if (!member) fail('PILOT_COUNTRIES_REQUIRED');
  return member;
}

export async function probeReviewSource({ manifest, state, source, env = process.env, fetchImpl = fetch }) {
  const member = sourceProbeCase(manifest);
  assertFreshReviewSources(manifest, source.conversations, [member.conversationId]);
  const conversation = source.conversations[0];
  const variables = state.catalog.filter(variable => variable.active && !variable.retired && supportsAiVariable(variable)).slice(0, 8);
  if (!variables.length || variables.some(variable => !/^[a-z][a-z0-9_]{0,159}$/.test(variable.id))) fail('UNSUPPORTED_VARIABLE');
  const before = digest(state), redactions = [env.AGENT_SHARED_TOKEN, env.GATEWAY_BASE_URL, env.GATEWAY_PORTAL_KEY].filter(Boolean);
  let networkCalls = 0, transport = null, requestSchema = null;
  const blockedAdditionalOperations = [];
  const observedFetch = async (url, options) => {
    let request;
    try { request = JSON.parse(options.body); } catch { fail('AI_CONFIGURATION'); }
    if (networkCalls) {
      const operation = `${request.method} ${request.path}`;
      blockedAdditionalOperations.push(['GET /v1/models', 'GET /api/v1/models', 'POST /v1/chat/completions'].includes(operation) ? operation : 'other');
      throw new Error('ONE_REQUEST_LIMIT');
    }
    if (options.method !== 'POST' || request.method !== 'POST' || request.path !== '/v1/chat/completions'
      || request.body?.model !== 'gemma-4-26b-a4b-it-mlx') fail('AI_CONFIGURATION');
    networkCalls++;
    const schema = request.body.response_format?.json_schema?.schema, serialized = schema ? JSON.stringify(schema) : '';
    requestSchema = { responseFormat: request.body.response_format?.type === 'json_schema' ? 'json_schema' : 'json_object',
      schemaHash: schema ? digest(schema) : null, requestHash: digest(request.body),
      keywords: keywords.filter(keyword => serialized.includes(`"${keyword}"`)) };
    const response = await fetchImpl(url, options);
    transport = { httpStatus: response.status, upstreamStatus: null, returnedModel: null, technicalError: null };
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
        if (Number.isInteger(body?.upstream_status_code) && body.upstream_status_code >= 100 && body.upstream_status_code <= 599) transport.upstreamStatus = body.upstream_status_code;
        if (typeof body?.response?.model === 'string' && /^gemma-4-26b-a4b-it-mlx(?::\d+)?$/.test(body.response.model)) transport.returnedModel = body.response.model;
        if (!response.ok || body?.ok === false || transport.upstreamStatus >= 400) {
          const error = body?.response?.error ?? body?.error
            ?? (typeof body?.response === 'string' || typeof body?.response?.message === 'string' ? body.response : undefined);
          transport.technicalError = sanitizedUpstreamError(error, redactions);
          transport.errorHash = error === undefined ? null : digest(error);
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
  try { result = await profile.evaluator.evaluate(structuredClone(conversation), variables); }
  catch (caught) { error = probeErrorDiagnostic(caught); }
  const feedback = evaluationValidationFeedback(variables, result?.validationErrors);
  return { phase: 'real-source-rejection', checkedAt: new Date().toISOString(), requestId: manifest.id,
    country: 'HN', sourceVerified: true, sourceHash: sourceFingerprint(conversation), messageCount: conversation.messages.length,
    synthetic: false, databaseChanged: false, published: false, configurationUnchanged: before === digest(state),
    profileId: 'gemma-local', model: 'gemma-4-26b-a4b-it-mlx', configurationHash: registry.snapshot(profile).configurationHash,
    runtimeHash: digest(runtime), requestedVariables: variables.map(variable => variable.id),
    includesDescriptor: variables.some(variable => variable.type === 'Descriptor'),
    durationMs: Date.now() - started, networkCalls, blockedAdditionalOperations, requestSchema, transport,
    validResults: Array.isArray(result?.results) ? result.results.length : 0, validationErrors: feedback,
    completed: !error && result?.model === profile.model && result.results?.length === variables.length && !feedback.length, error };
}

export async function readSourceProbe(reader, manifest) {
  const member = sourceProbeCase(manifest);
  const source = await reader.read({ fresh: true, conversationIds: [member.conversationId] });
  assertFreshReviewSources(manifest, source.conversations, [member.conversationId]);
  return source;
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
  const result = await probeReviewSource({ ...saved, source });
  console.log(JSON.stringify(result));
  process.exitCode = result.completed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.log(JSON.stringify({ phase: 'real-source-rejection-failed', databaseChanged: false, error: probeErrorDiagnostic(error) }));
    process.exitCode = 2;
  });
}
