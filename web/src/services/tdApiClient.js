import { apiBaseUrl } from '../config.js';

const base = `${apiBaseUrl}/integrations/td`;
const result = (success, message, data = null, error = null) => ({ success, message, data, error });

export async function tdApiRequest(path, { method = 'GET', query, body, responseType = 'json', signal } = {}) {
  const url = new URL(`${base}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetch(url, { method, credentials: 'same-origin', signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    return result(false, 'No se pudo conectar con Pulso.', null, { code: 'NETWORK_ERROR' });
  }
  if (response.status === 401) window.dispatchEvent(new Event('pulso:unauthorized'));
  if (responseType === 'blob' && response.ok) {
    try { return result(true, 'Archivo descargado.', await response.blob()); }
    catch { return result(false, 'No se pudo leer el archivo.', null, { code: 'INVALID_RESPONSE' }); }
  }
  try {
    const payload = await response.json();
    if (!payload || typeof payload.success !== 'boolean') return result(false, 'Pulso devolvió una respuesta no válida.', null, { code: 'INVALID_RESPONSE' });
    return payload;
  } catch { return result(false, 'Pulso devolvió una respuesta no válida.', null, { code: 'INVALID_RESPONSE' }); }
}
