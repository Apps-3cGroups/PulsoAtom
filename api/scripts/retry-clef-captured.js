import { pathToFileURL } from 'node:url';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { GatewayEvaluator } from '../src/gateway-evaluator.js';
import { catalogReferences, digest, evaluationContext } from '../src/evaluation-context.js';
import { supportsAiVariable } from '../src/evaluator.js';
import { readProbeState } from './check-clef-conversation.js';

const directory = '/var/www/nodeapps/PulsoAtom/api/.data/diagnostics';
const model = 'clef-flash', conversationId = '6135';
const allowedErrors = new Set(['AI_CONFIGURATION', 'AI_UNAVAILABLE', 'AI_TRANSIENT', 'INVALID_AI_RESULT',
  'MODEL_CHANGED', 'MODEL_IDENTITY_UNVERIFIED', 'AI_SAFETY_REFUSAL', 'AI_INCOMPLETE']);
const allowedRules = new Set(['missing_item', 'invalid_status', 'invalid_value_type', 'invalid_reason', 'invalid_evidence_count',
  'unknown_evidence_message', 'missing_evidence', 'unexpected_evidence', 'inconsistent_status_value', 'unexpected_fields']);
const fail = code => { const error = new Error('No se completó el diagnóstico aislado.'); error.code = code; throw error; };
const readJson = filename => readFile(filename, 'utf8').then(JSON.parse);
async function optionalJson(filename) {
  try { return await readJson(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
async function writePrivate(filename, value) {
  const temporary = `${filename}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, filename);
  const parent = await open(path.dirname(filename), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
const project = result => ({ variableId: result.variableId, type: result.type, method: result.method,
  status: result.status, value: result.value, reason: result.reason,
  evidenceMessageIds: (result.evidence || []).map(item => item.messageId),
  ...(result.aiResult ? { aiResult: { status: result.aiResult.status, value: result.aiResult.value,
    reason: result.aiResult.reason, evidenceMessageIds: (result.aiResult.evidence || []).map(item => item.messageId) },
  codeRule: result.codeRule } : {}) });
const safeErrors = errors => (errors || []).map(({ variableId, rules }) => ({ variableId, rules }));
function assertIdle(state) {
  if (state.settings?.dailyEnabled !== false) fail('DAILY_NOT_PAUSED');
  if (!state.activity || ['jobs', 'tasks', 'attempts'].some(key => Number(state.activity[key]) !== 0)) fail('EVALUATION_RUNNING');
}
function assertResults(response, variables) {
  if (response.model !== model || !Array.isArray(response.results) || !Array.isArray(response.validationErrors)
    || response.results.some(result => !variables.some(variable => variable.id === result.variableId))
    || new Set(response.results.map(result => result.variableId)).size !== response.results.length) fail('INVALID_AI_RESULT');
}
function completedArtifact(artifact) {
  if (!artifact) return null;
  if (artifact.format !== 1 || artifact.model !== model || artifact.conversationId !== conversationId
    || artifact.operation !== 'retry-captured-clef-checklist' || !artifact.finishedAt || !artifact.summary) fail('INVALID_FINAL_ARTIFACT');
  return { ...artifact.summary, reused: true, networkRequests: 0 };
}

// Replays the already captured full answer, then makes at most one request for
// its invalid/missing variables. No store, jobs, policy or evaluation DB writes.
export async function retryCapturedClef({ connection, reader, env = process.env, fetchImpl = fetch,
  outputDirectory = directory, readState = readProbeState } = {}) {
  const firstCapturePath = path.join(outputDirectory, 'clef-flash-6135-response-20261107.json');
  const baselinePath = path.join(outputDirectory, 'clef-flash-6135-adapted-20261107-v1.json');
  const retryCapturePath = path.join(outputDirectory, 'clef-flash-6135-retry-response-20261107-v1.json');
  const outputPath = path.join(outputDirectory, 'clef-flash-6135-retried-20261107-v1.json');
  const existing = completedArtifact(await optionalJson(outputPath));
  if (existing) return existing;
  if ((env.GATEWAY_PORTAL_KEY ?? 'portal-pulso') !== 'portal-pulso') fail('AI_CONFIGURATION');
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const lock = await open(`${outputPath}.lock`, 'wx', 0o600);
  let networkRequests = 0, replayedResponses = 0;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await lock.sync();
    const concurrent = completedArtifact(await optionalJson(outputPath));
    if (concurrent) return concurrent;
    const [baseline, captured] = await Promise.all([readJson(baselinePath), readJson(firstCapturePath)]);
    if (baseline.format !== 1 || baseline.model !== model || baseline.conversationId !== conversationId
      || !baseline.context || captured.format !== 1 || captured.httpStatus !== 200
      || !/^[a-f0-9]{64}$/.test(captured.requestHash) || captured.envelope?.response?.model !== model) fail('INVALID_BASELINE');
    const before = await readState(connection, { chooseReference: true });
    assertIdle(before);
    if (String(before.reference?.conversationId) !== conversationId) fail('REFERENCE_CHANGED');
    const source = await reader.read({ fresh: true, conversationIds: [conversationId] });
    const conversation = source.conversations.find(item => item.id === conversationId);
    if (source.conversations.length !== 1 || !conversation?.messages?.length) fail('INVALID_SOURCE');
    const context = evaluationContext(conversation, before.catalog);
    if (digest(context) !== digest(baseline.context)
      || digest(catalogReferences(before.catalog)) !== digest(baseline.catalogVersions)) fail('CONTENT_OR_CATALOG_CHANGED');
    const variables = before.catalog.filter(variable => variable.active && !variable.retired && supportsAiVariable(variable));
    if (!variables.length || new Set(variables.map(variable => variable.id)).size !== variables.length) fail('INVALID_CATALOG');
    const makeEvaluator = requestFetch => new GatewayEvaluator({ baseUrl: env.GATEWAY_BASE_URL, token: env.AGENT_SHARED_TOKEN,
      portalKey: 'portal-pulso', toolKey: 'gemma', model, timeoutMs: 180000, maxTokens: 16000,
      temperature: 0, responseFormat: 'json_schema', fetchImpl: requestFetch });
    function requestHash(options) {
      const request = JSON.parse(options.body);
      if (request.method !== 'POST' || request.path !== '/v1/chat/completions' || request.body?.model !== model
        || request.body.response_format?.type !== 'json_schema') fail('INVALID_REQUEST');
      return digest(request.body);
    }
    const first = await makeEvaluator(async (_url, options) => {
      if (requestHash(options) !== captured.requestHash) fail('CAPTURE_REQUEST_CHANGED');
      replayedResponses++;
      return new Response(JSON.stringify(captured.envelope), { status: captured.httpStatus });
    }).evaluate(conversation, variables);
    assertResults(first, variables);
    const retained = new Map(first.results.map(result => [result.variableId, result]));
    const pending = variables.filter(variable => !retained.has(variable.id));
    const artifact = { format: 1, operation: 'retry-captured-clef-checklist', model, conversationId,
      startedAt: new Date().toISOString(), context, catalogVersions: baseline.catalogVersions,
      firstAttempt: { requestHash: captured.requestHash, validVariables: first.results.length,
        responseField: first.responseField, validationErrors: safeErrors(first.validationErrors) },
      retryVariableIds: pending.map(variable => variable.id), retry: null };
    let retryCapture, retryError = null, validationErrors = first.validationErrors;
    if (pending.length) {
      const started = Date.now();
      try {
        const response = await makeEvaluator(async (url, options) => {
          const hash = requestHash(options);
          retryCapture = await optionalJson(retryCapturePath);
          if (retryCapture) {
            if (retryCapture.format !== 1 || retryCapture.requestHash !== hash
              || !Number.isInteger(retryCapture.httpStatus) || retryCapture.httpStatus < 200 || retryCapture.httpStatus > 599) fail('RETRY_CAPTURE_CHANGED');
            replayedResponses++;
            return new Response(JSON.stringify(retryCapture.envelope), { status: retryCapture.httpStatus });
          }
          if (networkRequests !== 0) fail('INFERENCE_LIMIT');
          // Durable reservation prevents a timeout/crash from being sent twice.
          const sent = await open(`${retryCapturePath}.sent`, 'wx', 0o600);
          try { await sent.writeFile(JSON.stringify({ requestHash: hash, startedAt: new Date().toISOString() })); await sent.sync(); }
          finally { await sent.close(); }
          networkRequests++;
          const rawResponse = await fetchImpl(url, options);
          let envelope = null;
          try { envelope = await rawResponse.clone().json(); } catch {}
          retryCapture = { format: 1, requestHash: hash, capturedAt: new Date().toISOString(),
            httpStatus: rawResponse.status, envelope };
          await writePrivate(retryCapturePath, retryCapture);
          return rawResponse;
        }).evaluate(conversation, pending, { validationErrors: first.validationErrors });
        assertResults(response, pending);
        for (const result of response.results) retained.set(result.variableId, result);
        validationErrors = response.validationErrors;
        artifact.retry = { responseField: response.responseField, validVariables: response.results.length,
          validationErrors: safeErrors(response.validationErrors), durationMs: Date.now() - started };
      } catch (error) {
        retryError = allowedErrors.has(error?.code) ? error.code : 'RETRY_DIAGNOSIS_FAILED';
        artifact.retry = { errorCode: retryError, validVariables: 0, durationMs: Date.now() - started };
      }
    }
    const [after, updated] = await Promise.all([readState(connection), reader.read({ fresh: true, conversationIds: [conversationId] })]);
    const current = updated.conversations.find(item => item.id === conversationId);
    const sourceUnchanged = updated.conversations.length === 1 && !!current && digest(evaluationContext(current, after.catalog)) === digest(context);
    const configurationUnchanged = digest({ settings: before.settings, catalog: before.catalog }) === digest({ settings: after.settings, catalog: after.catalog });
    const idleAfter = after.settings?.dailyEnabled === false && ['jobs', 'tasks', 'attempts'].every(key => Number(after.activity?.[key]) === 0);
    artifact.results = [...retained.values()].map(project);
    artifact.validationErrors = safeErrors(validationErrors);
    artifact.finishedAt = new Date().toISOString();
    const complete = retained.size === variables.length && !retryError && !validationErrors.length;
    const stable = sourceUnchanged && configurationUnchanged && idleAfter;
    const preliminaries = [...retained.values()].map(result => ({ ...result, preliminary: result.aiResult || result }));
    const validationRuleCounts = {};
    for (const error of validationErrors) for (const rule of error.rules || []) {
      if (allowedRules.has(rule)) validationRuleCounts[rule] = (validationRuleCounts[rule] || 0) + 1;
    }
    artifact.summary = { operation: artifact.operation, success: complete && stable, reused: false, conversationId, model,
      status: !stable ? 'changed' : complete ? 'completed' : retained.size ? 'partial' : 'failed',
      networkRequests, replayedResponses, requestedVariables: variables.length, retainedFirstAttempt: first.results.length,
      retriedVariables: pending.length, validVariables: retained.size, pendingVariables: variables.length - retained.size,
      abstentions: preliminaries.filter(item => item.preliminary.status === 'no_evaluado').length,
      preliminaryFlags: preliminaries.filter(item => item.type === 'Flag' && item.preliminary.status === 'evaluado' && item.preliminary.value === 1).length,
      validationRuleCounts, errorCode: retryError,
      retryProtocol: retryCapture ? { gatewayHttpStatus: retryCapture.httpStatus,
        upstreamStatus: Number.isInteger(retryCapture.envelope?.upstream_status_code)
          && retryCapture.envelope.upstream_status_code >= 100 && retryCapture.envelope.upstream_status_code <= 599
          ? retryCapture.envelope.upstream_status_code : null,
        actualModel: retryCapture.envelope?.response?.model === model ? model : null } : null,
      retryResponseField: artifact.retry?.responseField ?? null, retryDurationMs: artifact.retry?.durationMs ?? 0,
      sourceUnchanged, configurationUnchanged, idleAfter,
      note: 'Prueba aislada de una conversación. Sin escrituras en evaluaciones, configuración o política de Pulso.' };
    await writePrivate(outputPath, artifact);
    return artifact.summary;
  } finally { await lock.close(); await unlink(`${outputPath}.lock`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let connection, reader;
  try {
    if (process.argv.length !== 2) fail('INVALID_ARGUMENTS');
    const { config, databaseConfig, atomDatabaseConfig } = await import('../src/config.js');
    const db = databaseConfig(), atom = atomDatabaseConfig();
    if (config.demo || db?.database !== 'dbPulsosAtom' || !atom) fail('INVALID_SETTINGS');
    const { default: mysql } = await import('mysql2/promise');
    const { AtomReader } = await import('../src/atom.js');
    const { connectionLimit, ...options } = db;
    connection = await mysql.createConnection(options); reader = new AtomReader(atom, config.timezone);
    const result = await retryCapturedClef({ connection, reader });
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.success ? 0 : 1;
  } catch {
    console.error(JSON.stringify({ operation: 'retry-captured-clef-checklist', success: false,
      error: 'RETRY_CHECK_FAILED', message: 'No se completó la prueba aislada; no se modificaron evaluaciones ni configuración.' }));
    process.exitCode = 2;
  } finally { await Promise.all([connection?.end(), reader?.close()]); }
}
