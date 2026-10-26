const BASE = '/pulso/api';
export class ApiError extends Error {
  constructor(message, status, code, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
export async function api(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, { method, credentials: 'same-origin', signal, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('No se pudo conectar con Pulso. Comprueba que la API esté iniciada.', 0, 'NETWORK_ERROR');
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok || !data) {
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('pulso:unauthorized'));
    throw new ApiError(data?.error?.message || 'No se recibió una respuesta válida del servidor.', response.status, data?.error?.code, data?.error?.details);
  }
  return data;
}
export function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== '' && value !== undefined && value !== null) params.set(key, String(value));
  return params.toString();
}
