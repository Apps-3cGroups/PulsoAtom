import { AppError } from '../errors.js';

// This is a backend-only transport. No provider URL returned by the catalog is
// ever used as a network destination: requests always go through the Gateway.
const allowedOperations = new Set(['POST /v1/chat/completions', 'GET /v1/models']);
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const requestIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const safeBaseUrl = value => {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.toString().replace(/\/$/, '');
  } catch { return null; }
};
const httpError = status => new AppError(502,
  `El Gateway rechazó la solicitud al modelo local (HTTP ${status}).`,
  [408, 429].includes(status) || status >= 500 ? 'AI_TRANSIENT' : 'AI_CONFIGURATION');
const invalidEnvelope = () => new AppError(502, 'El Gateway devolvió una respuesta inválida.', 'INVALID_AI_RESULT');

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
  async #request(path, options = {}) {
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
    if (!response.ok) throw httpError(response.status);
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
    });
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || typeof envelope.ok !== 'boolean' || !Number.isInteger(envelope.upstream_status_code)) throw invalidEnvelope();
    const status = envelope.upstream_status_code;
    if (status < 100 || status > 599) throw invalidEnvelope();
    if (status < 200 || status >= 300) throw httpError(status);
    if (!envelope.ok || envelope.tool_key !== toolKey || envelope.method !== method || envelope.path !== path
      || !requestIdPattern.test(envelope.request_uuid || '') || !Object.hasOwn(envelope, 'response')) throw invalidEnvelope();
    return { response: envelope.response, requestId: envelope.request_uuid,
      latencyMs: Number.isFinite(envelope.latency_ms) && envelope.latency_ms >= 0 ? envelope.latency_ms : null };
  }
}
