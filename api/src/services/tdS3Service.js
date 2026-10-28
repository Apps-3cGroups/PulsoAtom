import { tdApiClient } from './tdApiClient.js';

const fail = (message, code) => ({ success: false, message, data: null, error: { code } });
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\/\x00-\x1f]/.test(value);
const maxBodyBytes = 50 * 1024 * 1024;

export function createTdS3Service(client = tdApiClient) {
  return {
    async uploadFileToS3(payload) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail('Indica un archivo para subir.', 'INVALID_UPLOAD');
      if (payload.s3Key !== undefined && !validKey(payload.s3Key)) return fail('s3Key no puede incluir separadores de ruta ni caracteres de control.', 'INVALID_S3_KEY');
      if (!payload.s3Key && (typeof payload.fileName !== 'string' || !payload.fileName.trim())) return fail('Indica fileName o s3Key.', 'MISSING_FILE_NAME');
      if (!['fileText', 'fileBase64', 'jsonBody'].some(key => payload[key] !== undefined)) return fail('Indica fileText, fileBase64 o jsonBody.', 'MISSING_FILE_CONTENT');
      let bodySize;
      try { bodySize = Buffer.byteLength(JSON.stringify(payload)); }
      catch { return fail('El contenido del archivo no es JSON válido.', 'INVALID_UPLOAD'); }
      if (bodySize > maxBodyBytes) return fail('El archivo supera el límite de 50 MB de TD.', 'FILE_TOO_LARGE');
      return client.request({ method: 'POST', path: '/s3/upload', body: payload });
    },
    async getS3TemporaryUrl({ s3Key, expiresInSeconds } = {}) {
      if (!validKey(s3Key)) return fail('s3Key no puede incluir separadores de ruta ni caracteres de control.', 'INVALID_S3_KEY');
      if (expiresInSeconds !== undefined && (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800)) return fail('expiresInSeconds debe estar entre 1 y 604800.', 'INVALID_EXPIRATION');
      return client.request({ path: '/s3/url', query: { s3Key, expiresInSeconds } });
    },
    async downloadS3File({ s3Key } = {}) {
      if (!validKey(s3Key)) return fail('s3Key no puede incluir separadores de ruta ni caracteres de control.', 'INVALID_S3_KEY');
      return client.request({ path: '/s3/download', query: { s3Key }, responseType: 'binary' });
    },
  };
}

export const { uploadFileToS3, getS3TemporaryUrl, downloadS3File } = createTdS3Service();
