import { pathToFileURL } from 'node:url';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../src/errors.js';
import { GatewayEvaluator } from '../src/gateway-evaluator.js';
import { catalogReferences, digest, evaluationContext } from '../src/evaluation-context.js';
import { supportsAiVariable } from '../src/evaluator.js';
import { safeGatewayErrorDetails } from '../src/services/safeGatewayError.js';
import { summarizeModelResponse } from '../src/services/modelResponseShape.js';

const maintenanceId = '77f134e8-fdf8-4154-b1f6-485c159b9194';
const defaultOutput = '/var/www/nodeapps/PulsoAtom/api/.data/diagnostics/clef-flash-real-2026-11-07.json';
const model = 'clef-flash', toolKey = 'gemma';
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = code => { throw new AppError(409, 'No se completó la prueba aislada de Clef.', code); };
const codes = new Set(['AI_CONFIGURATION', 'AI_UNAVAILABLE', 'AI_TRANSIENT', 'INVALID_AI_RESULT', 'MODEL_CHANGED',
  'MODEL_IDENTITY_UNVERIFIED', 'AI_SAFETY_REFUSAL', 'AI_INCOMPLETE', 'INVALID_SOURCE', 'INVALID_CATALOG',
  'EVALUATION_RUNNING', 'DAILY_NOT_PAUSED', 'GEMMA_REFERENCE_MISSING', 'INVALID_SETTINGS']);
const errorCode = error => error instanceof AppError && codes.has(error.code) ? error.code : 'CLEF_CONVERSATION_CHECK_FAILED';
const rules = new Set(['missing_item', 'invalid_status', 'invalid_value_type', 'invalid_reason', 'invalid_evidence_count',
  'unknown_evidence_message', 'missing_evidence', 'unexpected_evidence', 'inconsistent_status_value']);

export async function readProbeState(connection, { chooseReference = false } = {}) {
  await connection.query('START TRANSACTION READ ONLY');
  try {
    const [catalog] = await connection.query('SELECT payload FROM catalog_items ORDER BY sequence_id');
    const [settings] = await connection.query("SELECT payload FROM portal_settings WHERE id = 'settings'");
    const [activity] = await connection.query(`SELECT
      (SELECT COUNT(*) FROM evaluation_jobs WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.status')) IN ('running','pending','queued')) AS jobs,
      (SELECT COUNT(*) FROM evaluation_tasks WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.status')) = 'running') AS tasks,
      (SELECT COUNT(*) FROM evaluation_attempts WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.status')) = 'running') AS attempts`);
    if (settings.length !== 1) fail('INVALID_SETTINGS');
    let reference = null;
    if (chooseReference) {
      const [selected] = await connection.execute(`SELECT e.payload FROM evaluations e
        INNER JOIN evaluation_tasks t ON JSON_UNQUOTE(JSON_EXTRACT(t.payload, '$.evaluationId')) = e.id
        INNER JOIN evaluation_jobs j ON JSON_UNQUOTE(JSON_EXTRACT(t.payload, '$.jobId')) = j.id
        WHERE JSON_UNQUOTE(JSON_EXTRACT(j.payload, '$.maintenanceId')) = ?
          AND JSON_UNQUOTE(JSON_EXTRACT(t.payload, '$.status')) = 'completed'
          AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.profileId')) = 'gemma-local'
          AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.partial')) = 'false'
          AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.purpose')) = 'operational'
        ORDER BY e.sequence_id DESC LIMIT 1`, [maintenanceId]);
      if (selected.length !== 1) fail('GEMMA_REFERENCE_MISSING');
      reference = decode(selected[0].payload);
    }
    const state = { catalog: catalog.map(row => decode(row.payload)), settings: decode(settings[0].payload), activity: activity[0], reference };
    await connection.commit();
    return state;
  } catch (error) { await connection.rollback(); throw error; }
}

function assertIdle(state) {
  if (!state.activity || ['jobs', 'tasks', 'attempts'].some(key => Number(state.activity[key]) !== 0)) fail('EVALUATION_RUNNING');
  if (state.settings.dailyEnabled !== false) fail('DAILY_NOT_PAUSED');
}
function safeId(value, env) {
  const secrets = Object.entries(env).filter(([key, item]) => /secret|token|password|key|url|host/i.test(key)
    && typeof item === 'string' && item.length >= 4).map(([, item]) => item);
  try { secrets.push(new URL(env.GATEWAY_BASE_URL).hostname); } catch {}
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/.test(value) && !value.includes('://')
    && !secrets.some(secret => value.toLowerCase().includes(secret.toLowerCase())) ? value : null;
}
const usage = value => Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens']
  .filter(key => Number.isSafeInteger(value?.[key]) && value[key] >= 0).map(key => [key, value[key]]));
const projectedResult = result => ({ variableId: result.variableId, type: result.type, method: result.method,
  status: result.status, value: result.value, reason: result.reason,
  evidenceMessageIds: (result.evidence || []).map(e => e.messageId),
  ...(result.aiResult ? { aiResult: { status: result.aiResult.status, value: result.aiResult.value,
    reason: result.aiResult.reason, evidenceMessageIds: (result.aiResult.evidence || []).map(e => e.messageId) }, codeRule: result.codeRule } : {}) });
const preliminary = result => result.aiResult || result;

async function writeArtifact(filename, artifact) {
  const temporary = `${filename}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(artifact, null, 2)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function completedArtifact(filename, requestMode) {
  try {
    const existing = JSON.parse(await readFile(filename, 'utf8'));
    if (existing.format !== 1 || existing.model !== model || existing.toolKey !== toolKey || !existing.finishedAt || !existing.summary
      || (existing.requestMode || 'schema') !== requestMode) fail('INVALID_SETTINGS');
    return { ...existing.summary, requestMode, reused: true };
  } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

// Isolated real-content probe: no store, jobs, evaluation persistence or policy changes.
export async function runClefConversationCheck({ connection, reader, env = process.env, fetchImpl = fetch,
  outputPath = defaultOutput, readState = readProbeState, requestMode = 'schema' } = {}) {
  if (!['schema', 'prompt-json', 'compact-json'].includes(requestMode)) fail('AI_CONFIGURATION');
  if ((env.GATEWAY_PORTAL_KEY ?? 'portal-pulso') !== 'portal-pulso') fail('AI_CONFIGURATION');
  const existing = await completedArtifact(outputPath, requestMode);
  if (existing) return existing;
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const lock = await open(`${outputPath}.lock`, 'wx', 0o600);
  let saved = false, inferenceStarted = false;
  const artifact = { format: 1, purpose: 'isolated-real-content-probe', model, toolKey, requestMode, requestHash: null,
    startedAt: new Date().toISOString(), conversationId: null, results: [], validationErrors: [], protocol: null };
  try {
    // Another process may have finished between the first read and this lock.
    // Recheck while owning the reservation before any source read or inference.
    const completed = await completedArtifact(outputPath, requestMode);
    if (completed) return completed;
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: artifact.startedAt })); await lock.sync();
    try {
      const before = await readState(connection, { chooseReference: true });
      assertIdle(before);
      const id = String(before.reference?.conversationId || '');
      if (!/^[1-9]\d*$/.test(id)) fail('INVALID_SOURCE');
      artifact.conversationId = id;
      const variables = before.catalog.filter(v => v.active && !v.retired && supportsAiVariable(v));
      if (!variables.length || new Set(variables.map(v => v.id)).size !== variables.length
        || variables.some(v => !/^[a-z][a-z0-9_]{0,159}$/.test(v.id))) fail('INVALID_CATALOG');
      artifact.requestedVariableIds = variables.map(v => v.id);
      const source = await reader.read({ fresh: true, conversationIds: [id] });
      const conversation = source.conversations.find(c => c.id === id);
      if (source.conversations.length !== 1 || !conversation?.messages.length) fail('INVALID_SOURCE');
      const context = evaluationContext(conversation, before.catalog);
      if (requestMode === 'schema') artifact.context = context;
      else artifact.baselineContext = context;
      artifact.catalogVersions = catalogReferences(before.catalog);
      artifact.messageCount = conversation.messages.length;
      artifact.gemmaReference = { evaluationId: before.reference.id,
        equivalent: requestMode === 'schema' && ['sourceHash', 'catalogHash', 'promptHash', 'rulesVersion'].every(key => before.reference[key] === context[key]) };
      const tracedFetch = async (...args) => {
        const [url, options] = args, invocation = JSON.parse(options.body);
        const body = invocation.body;
        if (invocation.method !== 'POST' || invocation.path !== '/v1/chat/completions' || body?.model !== model) fail('AI_CONFIGURATION');
        if (requestMode !== 'schema') {
          const schema = body.response_format?.json_schema?.schema;
          if (body.response_format?.type !== 'json_schema' || !schema || typeof schema !== 'object' || Array.isArray(schema)
            || !Array.isArray(body.messages)) fail('AI_CONFIGURATION');
          if (requestMode === 'compact-json') {
            if (body.messages[0]?.role !== 'system' || typeof body.messages[0]?.content !== 'string') fail('AI_CONFIGURATION');
            body.messages[0].content += '\n\nFormato obligatorio de salida: {"results":{"ID_VARIABLE":{"status":"evaluado","value":0,"reason":"Motivo breve en español","evidence_message_ids":[]}}}. Incluye exactamente una entrada por cada ID solicitado y ninguna propiedad adicional. El ejemplo de value=0 no es un resultado por defecto: decide cada variable. Para descriptores usa su categoría, lista o null según las instrucciones anteriores. No incluyas Markdown ni texto fuera del JSON. La respuesta final debe contener el objeto completo.';
          } else body.messages.splice(1, 0, { role: 'system', content: `Devuelve únicamente un objeto JSON que cumpla este esquema. No incluyas Markdown ni texto fuera del JSON: ${JSON.stringify(schema)}` });
          delete body.response_format;
        }
        artifact.requestHash = digest(body);
        args = [url, { ...options, body: JSON.stringify(invocation) }];
        const response = await fetchImpl(...args);
        const protocol = artifact.protocol = { gatewayHttpStatus: response.status, upstreamStatus: null, requestUuid: null,
          actualModel: null, finishReason: null, outputCharacters: 0, usage: {} };
        try {
          const envelope = await response.clone().json(), payload = envelope?.response, choice = payload?.choices?.length === 1 ? payload.choices[0] : null;
          protocol.responseShape = summarizeModelResponse(payload);
          protocol.upstreamStatus = Number.isInteger(envelope?.upstream_status_code) ? envelope.upstream_status_code : null;
          protocol.requestUuid = safeId(envelope?.request_uuid, env);
          protocol.actualModel = safeId(payload?.model, env);
          protocol.finishReason = ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(choice?.finish_reason) ? choice.finish_reason : null;
          protocol.outputCharacters = typeof choice?.message?.content === 'string' ? choice.message.content.length : 0;
          protocol.usage = usage(payload?.usage);
          if (!response.ok || envelope?.ok === false || protocol.upstreamStatus >= 400) protocol.errorDetails = safeGatewayErrorDetails(envelope, env);
        } catch {}
        return response;
      };
      const evaluator = new GatewayEvaluator({ baseUrl: env.GATEWAY_BASE_URL, token: env.AGENT_SHARED_TOKEN,
        portalKey: env.GATEWAY_PORTAL_KEY ?? 'portal-pulso', toolKey, model, timeoutMs: 180000,
        maxTokens: 16000, temperature: 0, responseFormat: 'json_schema', fetchImpl: tracedFetch });
      if (!evaluator.configured) fail('AI_CONFIGURATION');
      inferenceStarted = true;
      const started = Date.now();
      try {
        const result = await evaluator.evaluate(conversation, variables);
        artifact.results = result.results.map(projectedResult);
        artifact.validationErrors = result.validationErrors.map(error => ({ variableId: error.variableId,
          rules: error.rules.filter(rule => rules.has(rule)), code: 'INVALID_AI_RESULT' }));
      } catch (error) { artifact.errorCode = errorCode(error); }
      artifact.durationMs = Date.now() - started;
      const [after, updated] = await Promise.all([readState(connection), reader.read({ fresh: true, conversationIds: [id] })]);
      const current = updated.conversations.find(c => c.id === id);
      artifact.sourceUnchanged = !!current && digest(evaluationContext(current, after.catalog)) === digest(context);
      artifact.configurationUnchanged = digest({ catalog: before.catalog, settings: before.settings }) === digest({ catalog: after.catalog, settings: after.settings });
      artifact.idleAfter = ['jobs', 'tasks', 'attempts'].every(key => Number(after.activity?.[key]) === 0) && after.settings.dailyEnabled === false;
    } catch (error) { artifact.errorCode ||= errorCode(error); }
    const valid = artifact.results.length, requested = artifact.requestedVariableIds?.length || 0;
    const complete = !artifact.errorCode && valid === requested && requested > 0 && !artifact.validationErrors.length;
    const stable = artifact.sourceUnchanged === true && artifact.configurationUnchanged === true && artifact.idleAfter === true;
    const status = !stable && inferenceStarted && (complete || valid) ? 'changed' : complete ? 'completed' : valid ? 'partial' : 'failed';
    const safeProtocol = artifact.protocol ? (({ errorDetails, ...rest }) => rest)(artifact.protocol) : null;
    artifact.finishedAt = new Date().toISOString();
    artifact.summary = { success: complete && stable, status, reused: false, conversationId: artifact.conversationId,
      model, toolKey, requestMode, requestHash: artifact.requestHash, inferenceCount: inferenceStarted ? 1 : 0, requestedVariables: requested, validVariables: valid,
      abstentions: artifact.results.filter(r => preliminary(r).status === 'no_evaluado').length,
      pendingVariables: Math.max(0, requested - valid), preliminaryFlagIds: artifact.results.filter(r => r.type === 'Flag' && preliminary(r).status === 'evaluado' && preliminary(r).value === 1).map(r => r.variableId),
      validationErrors: artifact.validationErrors, errorCode: artifact.errorCode || null, protocol: safeProtocol,
      durationMs: artifact.durationMs || 0, sourceUnchanged: artifact.sourceUnchanged === true,
      configurationUnchanged: artifact.configurationUnchanged === true, gemmaComparable: artifact.gemmaReference?.equivalent === true && stable,
      note: 'Prueba aislada. Detecciones preliminares; no cambió la política ni se guardaron evaluaciones en Pulso.' };
    await writeArtifact(outputPath, artifact); saved = true;
    return artifact.summary;
  } finally {
    await lock.close();
    // A crashed inference or failed artifact write leaves its reservation intact.
    if (saved || !inferenceStarted) await unlink(`${outputPath}.lock`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let connection, reader;
  try {
    const postDeploy = process.argv.length === 3 && process.argv[2] === '--post-deploy';
    if (process.argv.length !== 2 && !postDeploy) throw new Error('Unsupported arguments');
    const { config, databaseConfig, atomDatabaseConfig } = await import('../src/config.js');
    const db = databaseConfig(), atom = atomDatabaseConfig();
    if (config.demo || db?.database !== 'dbPulsosAtom' || !atom) fail('INVALID_SETTINGS');
    const { default: mysql } = await import('mysql2/promise');
    const { AtomReader } = await import('../src/atom.js');
    const { connectionLimit, ...options } = db;
    connection = await mysql.createConnection(options); reader = new AtomReader(atom, config.timezone);
    const result = await runClefConversationCheck({ connection, reader,
      ...(postDeploy ? { outputPath: '/var/www/nodeapps/PulsoAtom/api/.data/diagnostics/clef-flash-postdeploy-fd4bb7ed-20261107-one-conversation.json' } : {}) });
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.success ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ success: false, code: error?.code === 'EEXIST' ? 'CHECK_RESERVED' : errorCode(error),
      message: 'No se completó la prueba aislada. No se modificaron evaluaciones ni configuración.' })); process.exitCode = 2;
  } finally { await Promise.all([connection?.end(), reader?.close()]); }
}
