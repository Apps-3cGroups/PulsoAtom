import test from 'node:test';
import assert from 'node:assert/strict';
import { fileToBase64, downloadBlob } from '../src/services/tdFileHelpers.js';

test('fileToBase64 entrega solo el contenido codificado y normaliza errores', async () => {
  const previous = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsDataURL() { this.result = 'data:text/plain;base64,SG9sYQ=='; this.onload(); }
  };
  try {
    assert.deepEqual(await fileToBase64(new Blob(['Hola'])), { success: true, message: 'Archivo convertido a base64.', data: 'SG9sYQ==', error: null });
    assert.equal((await fileToBase64(null)).error.code, 'INVALID_FILE');
  } finally { globalThis.FileReader = previous; }
});

test('downloadBlob valida el archivo antes de crear una descarga', () => {
  assert.equal(downloadBlob(null, 'archivo.txt').error.code, 'INVALID_DOWNLOAD');
  assert.equal(downloadBlob(new Blob(['Hola']), '').error.code, 'INVALID_DOWNLOAD');
});
