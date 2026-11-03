import { apiBaseUrl as BASE } from '../config.js';
export class ApiError extends Error {
  constructor(message, status, code, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
export async function api(path, { method = 'GET', body, signal, timeoutMs } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  try {
    const response = await fetch(`${BASE}${path}`, { method, credentials: 'same-origin', signal: controller.signal, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 204) return null;
    const contentType = response.headers.get('content-type') || '';
    let data = null;
    if (contentType.includes('application/json')) {
      try { data = await response.json(); }
      catch (error) {
        if (error.name !== 'SyntaxError') throw error;
        throw new ApiError('No se recibió una respuesta completa del servidor.', response.status, 'INVALID_RESPONSE');
      }
    }
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('pulso:unauthorized'));
    if (!response.ok || !data) throw new ApiError(data?.error?.message || 'No se recibió una respuesta válida del servidor.', response.status, data?.error?.code || 'INVALID_RESPONSE', data?.error?.details);
    return data;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timedOut) throw new ApiError('El servidor tardó demasiado en responder.', 0, 'TIMEOUT');
    if (error instanceof ApiError) throw error;
    if (error.name === 'AbortError') throw error;
    throw new ApiError('No se pudo conectar con Pulso. Comprueba tu conexión y vuelve a intentarlo.', 0, 'NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
export function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== '' && value !== undefined && value !== null) params.set(key, String(value));
  return params.toString();
}
