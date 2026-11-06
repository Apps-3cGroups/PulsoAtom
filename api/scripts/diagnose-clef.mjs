// Una petición sintética, sin BDD ni conversaciones. Ejecutar desde api/:
// node --env-file=.env scripts/diagnose-clef.mjs basic|schema|json
import { pathToFileURL } from 'node:url';

const modes = new Set(['basic', 'schema', 'json']);
const errorCodes = new Set(['invalid_request', 'invalid_request_error', 'invalid_argument', 'validation_error',
  'unsupported_parameter', 'unsupported_value', 'unsupported_response_format', 'invalid_json_schema', 'json_schema_not_supported',
  'model_not_found', 'model_not_loaded', 'context_length_exceeded', 'max_tokens_exceeded',
  'path_not_allowed', 'route_not_allowed', 'method_not_allowed', 'unsupported_method', 'tool_not_found']);
const errorTypes = new Set(['invalid_request_error', 'invalid_argument', 'validation_error', 'value_error', 'type_error',
  'not_found_error', 'permission_error', 'unsupported_parameter', 'unsupported_value']);
const errorParams = new Set(['model', 'messages', 'temperature', 'max_tokens', 'max_completion_tokens', 'response_format',
  'response_format.type', 'response_format.json_schema', 'response_format.json_schema.schema', 'response_format.json_schema.strict',
  'stream', 'method', 'path', 'body', 'timeout_ms']);
class DiagnosticInputError extends Error {}
const invalidMode = () => new DiagnosticInputError('Usa solamente un modo: basic, schema o json.');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const safeId = (value, secrets) => typeof value === 'string' && !secrets.some(secret => secret && value.includes(secret))
  && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(value) && !value.includes('://') ? value : null;

export function parseDiagnosticArgs(args) {
  if (args.length > 1 || (args.length === 1 && !modes.has(args[0]))) throw invalidMode();
  return args[0] || 'basic';
}

function errorMetadata(value, secrets) {
  const fields = [value?.error, value?.detail].filter(object);
  const metadata = {};
  for (const [key, allowed] of [['code', errorCodes], ['type', errorTypes], ['param', errorParams]]) {
    const found = fields.map(field => field[key]).find(item => typeof item === 'string'
      && !secrets.some(secret => secret && item.includes(secret)) && allowed.has(item));
    if (found !== undefined) metadata[key] = found;
  }
  return Object.keys(metadata).length ? metadata : null;
}

function errorHint(envelope) {
  // Error messages can echo the complete request or server configuration. They
  // only select a fixed, explicitly tentative hint; they never leave this process.
  const fields = [envelope?.error, envelope?.detail, envelope?.response?.error, envelope?.response?.detail];
  const text = fields.map(value => typeof value === 'string' ? value : object(value)
    ? [value.code, value.type, value.param, value.message].filter(v => typeof v === 'string').join(' ') : '').join(' ').toLowerCase();
  if (/(path|route|method|ruta|método)/.test(text) && /(not.allowed|not.permitted|forbidden|permitid|no habilitad)/.test(text)) return 'Revisar método o ruta permitida de la herramienta.';
  if (/response_format|json_schema|json schema|structured output/.test(text)) return 'Revisar el soporte y la estructura del formato JSON solicitado.';
  if (/context|token|max_tokens/.test(text)) return 'Revisar límite de contexto o de tokens.';
  if (/model/.test(text) && /not.found|unknown|not.loaded|unavailable|no existe/.test(text)) return 'Revisar disponibilidad e identificador del modelo.';
  return 'Consultar el motivo exacto en la auditoría del Gateway usando la hora y el request_uuid.';
}

export async function diagnose({ mode = 'basic', env = process.env, fetchImpl = fetch } = {}) {
  if (!modes.has(mode)) throw invalidMode();
  const token = typeof env.AGENT_SHARED_TOKEN === 'string' ? env.AGENT_SHARED_TOKEN.trim() : '';
  let base;
  try { base = new URL(env.GATEWAY_BASE_URL); } catch { throw new DiagnosticInputError('Falta GATEWAY_BASE_URL válida.'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new DiagnosticInputError('GATEWAY_BASE_URL debe ser una URL HTTP(S) sin credenciales ni parámetros.');
  }
  if (!token || /[\r\n]/.test(token)) throw new DiagnosticInputError('Falta AGENT_SHARED_TOKEN válida.');
  const portalKey = env.GATEWAY_PORTAL_KEY ?? 'portal-pulso';
  if (portalKey !== 'portal-pulso') throw new DiagnosticInputError('Esta prueba está delimitada a portal-pulso.');
  const secrets = [token, base.href, base.hostname];
  const body = { model: 'clef-flash', messages: [{ role: 'user',
    content: 'Prueba técnica sin datos reales. Responde únicamente el objeto JSON {"ok":true}.' }],
    temperature: 0, max_tokens: 128, stream: false };
  if (mode === 'schema') body.response_format = { type: 'json_schema', json_schema: {
    name: 'pulso_diagnostic', strict: true,
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
  } };
  if (mode === 'json') body.response_format = { type: 'json_object' };
  const startedAt = new Date().toISOString(), start = Date.now();
  let response;
  try {
    response = await fetchImpl(`${base.toString().replace(/\/$/, '')}/v1/tools/qwen/invoke`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(65000),
      headers: { 'X-Gateway-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ method: 'POST', path: '/v1/chat/completions', query: {}, body,
        timeout_ms: 60000, portal_key: portalKey,
        caller: { source: portalKey, mode: 'portal', operation: `diagnostico-clef-${mode}` } }),
    });
  } catch {
    return { success: false, transportAccepted: false, startedAt, durationMs: Date.now() - start, mode,
      failureLayer: 'transport', error: 'No se pudo completar la conexión al Gateway en 65 segundos. No se realizó un reintento automático.' };
  }
  let envelope;
  try { envelope = await response.json(); } catch { envelope = null; }
  const status = envelope?.upstream_status_code;
  const upstream = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const upstreamOk = upstream !== null && upstream >= 200 && upstream < 300;
  const payload = envelope?.response;
  const actualModel = safeId(payload?.model, secrets);
  const choice = Array.isArray(payload?.choices) && payload.choices.length === 1 ? payload.choices[0] : null;
  let contentMatches = false;
  if (typeof choice?.message?.content === 'string') {
    try { const parsed = JSON.parse(choice.message.content); contentMatches = object(parsed) && parsed.ok === true && Object.keys(parsed).length === 1; } catch {}
  }
  const envelopeMatches = envelope?.tool_key === 'qwen' && envelope?.method === 'POST' && envelope?.path === '/v1/chat/completions';
  const transportAccepted = response.ok === true && upstreamOk && envelope?.ok === true && envelopeMatches;
  const safeRequestId = safeId(envelope?.request_uuid, secrets);
  const requestUuid = safeRequestId && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(safeRequestId) ? safeRequestId : null;
  const success = transportAccepted && requestUuid !== null && actualModel === body.model && contentMatches
    && !choice?.message?.refusal && choice?.finish_reason === 'stop';
  return {
    success, transportAccepted, startedAt, durationMs: Date.now() - start, mode, portalKey, toolKey: 'qwen', requestedModel: body.model,
    gatewayHttpStatus: response.status, upstreamStatusCode: upstream, gatewayOk: typeof envelope?.ok === 'boolean' ? envelope.ok : null,
    requestUuid, actualModel, envelopeMatches, contentMatches,
    finishReason: ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(choice?.finish_reason) ? choice.finish_reason : null,
    gatewayError: errorMetadata(envelope, secrets), upstreamError: errorMetadata(payload, secrets),
    failureLayer: success ? null : !response.ok ? 'gateway_http' : !upstreamOk ? 'upstream_or_envelope' : 'response_contract',
    diagnosticHint: success ? 'La prueba mínima pasó; esto no acredita aún el checklist completo de Pulso.' : errorHint(envelope),
    hintIsHeuristic: !success,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await diagnose({ mode: parseDiagnosticArgs(process.argv.slice(2)) });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.success ? 0 : 1;
  } catch (error) {
    console.error(error instanceof DiagnosticInputError ? error.message : 'No se pudo completar el diagnóstico de Clef.');
    process.exitCode = 2;
  }
}
