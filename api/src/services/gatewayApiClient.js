import { AppError } from '../errors.js';

// This is a backend-only transport. No provider URL returned by the catalog is
// ever used as a network destination: requests always go through the Gateway.
const allowedOperations = new Set(['POST /v1/chat/completions', 'GET /v1/models', 'POST /v1/systemone', 'GET /api/v1/models']);
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const requestIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const safeBaseUrl = value => {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.toString().replace(/\/$/, '');
  } catch { return null; }
};
const httpError = (status, operation) => new AppError(502,
  `El Gateway rechazó la solicitud al modelo local (HTTP ${status}).`,
  status === 501 && operation === 'POST /v1/systemone' ? 'AI_CONFIGURATION'
    : [408, 429].includes(status) || status >= 500 ? 'AI_TRANSIENT' : 'AI_CONFIGURATION', { upstreamStatus: status });
const invalidEnvelope = () => new AppError(502, 'El Gateway devolvió una respuesta inválida.', 'INVALID_AI_RESULT');
const contextLimitCodes = new Set(['context_length_exceeded', 'context_window_exceeded', 'input_context_length_exceeded']);
const contextLimitPatterns = [
  /^(?:the\s+)?(?:maximum\s+)?context(?:\s+(?:length|window|size))?\s+(?:limit\s+)?(?:has\s+been\s+|was\s+|is\s+)?exceeded\b/i,
  /^(?:the\s+)?(?:input|prompt)(?:\s+token)?(?:\s+(?:length|size))?\s+(?:exceeds?|exceeded|is\s+too\s+long\s+for)\s+(?:the\s+)?(?:model['’]?s\s+)?(?:maximum\s+)?context(?:\s+(?:length|window|size))?\b/i,
  /^(?:this\s+model['’]?s\s+|the\s+model['’]?s\s+)?maximum\s+context\s+length\s+is\s+\d+\s+tokens\b[^\n]{0,500}\b(?:you\s+(?:requested|submitted)|your\s+(?:messages|request)\s+resulted\s+in)\s+\d+\s+tokens\b/i,
  /^trying\s+to\s+keep\s+the\s+first\s+\d+\s+tokens\s+when\s+context\s+overflows\b/i,
  /^cannot\s+truncate\s+prompt\s+with\s+n_keep\s*(?:=\s*\d+|\(\d+\))\s*>=\s*n_ctx\s*(?:=\s*\d+|\(\d+\))/i,
  /^(?:the\s+)?number\s+of\s+tokens\s+to\s+keep\s+from\s+the\s+(?:initial|system)\s+prompt\s+is\s+greater\s+than\s+the\s+context\s+(?:length|size|window)\b/i,
];
function isContextLimit(response, depth = 0) {
  // Inspect only documented error fields, never serialize arbitrary payloads
  // (which can contain prompts, transcripts, URLs or credentials). Matching is
  // anchored to the error itself so quoted conversation text is not a signal.
  if (typeof response === 'string') {
    if (response.length > 8192) return false;
    const message = response.trim().replace(/^error(?:\s+predicting)?:\s*/i, '');
    return contextLimitCodes.has(message) || contextLimitPatterns.some(pattern => pattern.test(message));
  }
  if (!response || typeof response !== 'object' || Array.isArray(response) || depth > 3) return false;
  return contextLimitCodes.has(response.code)
    || ['message', 'error', 'detail'].some(key => Object.hasOwn(response, key) && isContextLimit(response[key], depth + 1));
}
const resourceLimitCodes = new Set(['out_of_memory', 'insufficient_memory']);
const memoryException = /^(?:RuntimeError:\s*)?(?:\[METAL\]\s+Command buffer execution failed:\s*Insufficient Memory\s*\([^\r\n]{0,150}OutOfMemory\)|(?:CUDA\s+)?out of memory(?:[.:]\s*[^\r\n]{0,400})?)\s*$/i;
function isResourceLimit(response, depth = 0) {
  if (typeof response === 'string') {
    if (response.length > 8192) return false;
    const message = response.trim();
    if (memoryException.test(message)) return true;
    // Accept the terminal exception of an actual Python/MLX traceback, with
    // only the known prediction wrapper before it. Quoted input is not proof.
    const traceback = message.indexOf('Traceback (most recent call last):');
    if (traceback < 0) return false;
    const prefix = message.slice(0, traceback).trim();
    if (prefix && !/^Error in [\w .-]{1,80} prediction[:.]?\s*(?:Error in the [\w .-]{1,80} generation[:.]?\s*)?$/i.test(prefix)) return false;
    return memoryException.test(message.split(/\r?\n/).at(-1).trim());
  }
  if (!response || typeof response !== 'object' || Array.isArray(response) || depth > 3) return false;
  return resourceLimitCodes.has(response.code)
    || ['message', 'error', 'detail'].some(key => Object.hasOwn(response, key) && isResourceLimit(response[key], depth + 1));
}
const upstreamError = (status, operation, response) => {
  if (operation === 'POST /v1/chat/completions') {
    if ([400, 413, 422].includes(status) && isContextLimit(response)) {
      return new AppError(422, 'La conversación supera el contexto admitido por el modelo. Queda pendiente de revisión.', 'AI_CONTEXT_LIMIT');
    }
    if ([400, 413, 422, 500, 503].includes(status) && isResourceLimit(response)) {
      return new AppError(503, 'El modelo no tiene memoria suficiente para esta solicitud. Se requiere reducir el checklist o revisar su capacidad.', 'AI_RESOURCE_LIMIT');
    }
  }
  return httpError(status, operation);
};

export class GatewayApiClient {
  #token;
  constructor({ baseUrl, token, portalKey, timeoutMs = 180000, fetchImpl = fetch } = {}) {
    this.baseUrl = safeBaseUrl(baseUrl);
    this.#token = typeof token === 'string' ? token.trim() : '';
    this.portalKey = portalKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }
  get configured() {
    return !!(this.baseUrl && this.#token && !/[\r\n]/.test(this.#token) && keyPattern.test(this.portalKey || '')
      && Number.isInteger(this.timeoutMs) && this.timeoutMs >= 1000 && this.timeoutMs <= 180000);
  }
  async #request(path, options = {}, upstreamOperation) {
    if (!this.configured) throw new AppError(503, 'Falta configurar la conexión y la identidad de Pulso en el Gateway.', 'AI_CONFIGURATION');
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...options,
        // Do not forward a shared Gateway token to redirect destinations.
        redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs + 5000),
        headers: { 'X-Gateway-Token': this.#token, 'Content-Type': 'application/json', Accept: 'application/json' },
      });
    } catch {
      // Never propagate a fetch error: it can contain a URL or headers.
      throw new AppError(502, 'No se pudo contactar el Gateway dentro del tiempo permitido.', 'AI_UNAVAILABLE');
    }
    if (!response.ok) throw httpError(response.status, upstreamOperation);
    try { return await response.json(); } catch { throw invalidEnvelope(); }
  }
  async listTools() {
    // The catalog's envelope is not specified in the integration guide. Leave
    // its interpretation to the backend preflight; never assume allowed paths.
    const catalog = await this.#request('/v1/tools', { method: 'GET' });
    if (!catalog || typeof catalog !== 'object') throw invalidEnvelope();
    return catalog;
  }
  async invoke({ toolKey, method, path, query = {}, body = null, operation = 'evaluacion-calidad' } = {}) {
    if (!keyPattern.test(toolKey || '') || !allowedOperations.has(`${method} ${path}`)
      || !keyPattern.test(operation || '') || !query || typeof query !== 'object' || Array.isArray(query)) {
      throw new AppError(422, 'La operación solicitada al Gateway no está admitida por Pulso.', 'AI_CONFIGURATION');
    }
    const envelope = await this.#request(`/v1/tools/${encodeURIComponent(toolKey)}/invoke`, {
      method: 'POST',
      body: JSON.stringify({ method, path, query, body, timeout_ms: this.timeoutMs,
        portal_key: this.portalKey, caller: { source: this.portalKey, mode: 'portal', operation } }),
    }, `${method} ${path}`);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || typeof envelope.ok !== 'boolean' || !Number.isInteger(envelope.upstream_status_code)) throw invalidEnvelope();
    const status = envelope.upstream_status_code;
    if (status < 100 || status > 599) throw invalidEnvelope();
    if (status < 200 || status >= 300) throw upstreamError(status, `${method} ${path}`, envelope.response);
    if (!envelope.ok || envelope.tool_key !== toolKey || envelope.method !== method || envelope.path !== path
      || !requestIdPattern.test(envelope.request_uuid || '') || !Object.hasOwn(envelope, 'response')) throw invalidEnvelope();
    return { response: envelope.response, requestId: envelope.request_uuid,
      latencyMs: Number.isFinite(envelope.latency_ms) && envelope.latency_ms >= 0 ? envelope.latency_ms : null };
  }
}
