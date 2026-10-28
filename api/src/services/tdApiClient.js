const defaultTimeoutMs = 30000;

const result = (success, message, data = null, error = null) => ({ success, message, data, error });

export function createTdApiClient({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = defaultTimeoutMs } = {}) {
  return {
    async request({ method = 'GET', path, query, body, responseType = 'json' }) {
      const configuredBase = baseUrl === undefined ? process.env.TD_API_BASE_URL || process.env['URL-Base'] : baseUrl;
      if (!configuredBase) return result(false, 'Configura TD_API_BASE_URL para conectar con la API TD.', null, { code: 'TD_NOT_CONFIGURED' });
      let url;
      try {
        const base = new URL(configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`);
        if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('El servicio TD requiere HTTPS.');
        if (base.username || base.password || base.search || base.hash || !path?.startsWith('/')) throw new Error('Configuración o ruta TD inválida.');
        url = new URL(path.slice(1), base);
        for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      } catch {
        return result(false, 'La URL base de TD no es válida.', null, { code: 'TD_INVALID_URL' });
      }
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        const code = cause?.name === 'TimeoutError' || cause?.name === 'AbortError' ? 'TD_TIMEOUT' : 'TD_UNAVAILABLE';
        return result(false, code === 'TD_TIMEOUT' ? 'La API TD tardó demasiado en responder.' : 'No se pudo conectar con la API TD.', null, { code });
      }
      if (responseType === 'binary' && response.ok) {
        try {
          const bytes = Buffer.from(await response.arrayBuffer());
          return result(true, 'Archivo descargado.', { bytes, contentType: response.headers.get('content-type') || 'application/octet-stream', contentDisposition: response.headers.get('content-disposition') }, null);
        } catch {
          return result(false, 'No se pudo leer el archivo de TD.', null, { code: 'TD_INVALID_RESPONSE' });
        }
      }
      let payload;
      try {
        const text = await response.text();
        payload = text ? JSON.parse(text) : null;
      } catch {
        return result(false, 'La API TD devolvió una respuesta no válida.', null, { code: 'TD_INVALID_RESPONSE', status: response.status });
      }
      const success = response.ok && payload?.success !== false;
      const message = payload?.message || (success ? 'Operación completada.' : 'La API TD rechazó la operación.');
      return result(success, message, success ? (payload?.data ?? payload) : null, success ? null : { code: payload?.error?.code || payload?.code || 'TD_REQUEST_FAILED', status: response.status, details: payload?.error || null });
    },
  };
}

export const tdApiClient = createTdApiClient();
