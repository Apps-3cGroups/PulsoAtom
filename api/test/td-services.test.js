import test from 'node:test';
import assert from 'node:assert/strict';
import { createTdApiClient } from '../src/services/tdApiClient.js';
import { createTdS3Service } from '../src/services/tdS3Service.js';
import { createTdMailService } from '../src/services/tdMailService.js';

function clientWithRecorder(handler) {
  const requests = [];
  const client = createTdApiClient({ baseUrl: 'https://td.example/api/v1', fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return handler(url, options);
  } });
  return { client, requests };
}

test('S3 sube JSON y binarios, genera URL temporal y descarga bytes sin JWT', async () => {
  const { client, requests } = clientWithRecorder((url) => url.pathname.endsWith('/download')
    ? new Response(Buffer.from([0, 1, 255]), { headers: { 'content-type': 'image/png' } })
    : Response.json({ success: true, message: 'OK', data: { value: 'done' } }));
  const s3 = createTdS3Service(client);
  assert.equal((await s3.uploadFileToS3({ fileName: 'prueba.json', jsonBody: { ok: true } })).success, true);
  assert.equal((await s3.uploadFileToS3({ fileName: 'imagen.png', fileBase64: 'AAH/', contentType: 'image/png' })).success, true);
  assert.equal((await s3.getS3TemporaryUrl({ s3Key: 'prueba.json', expiresInSeconds: 900 })).success, true);
  const download = await s3.downloadS3File({ s3Key: 'imagen.png' });
  assert.equal(download.success, true);
  assert.deepEqual([...download.data.bytes], [0, 1, 255]);
  assert.equal(download.data.contentType, 'image/png');
  assert.deepEqual(requests.map(r => new URL(r.url).pathname), ['/api/v1/s3/upload', '/api/v1/s3/upload', '/api/v1/s3/url', '/api/v1/s3/download']);
  assert.equal(new URL(requests[2].url).searchParams.get('expiresInSeconds'), '900');
  assert.equal(requests.every(r => !r.options.headers?.Authorization), true);
});

test('S3 rechaza claves con ruta, expiración excesiva y archivos demasiado grandes', async () => {
  const { client, requests } = clientWithRecorder(() => Response.json({ success: true }));
  const s3 = createTdS3Service(client);
  assert.equal((await s3.getS3TemporaryUrl({ s3Key: 'carpeta/archivo.pdf' })).error.code, 'INVALID_S3_KEY');
  assert.equal((await s3.downloadS3File({ s3Key: 'carpeta\\archivo.pdf' })).error.code, 'INVALID_S3_KEY');
  assert.equal((await s3.getS3TemporaryUrl({ s3Key: 'archivo.pdf', expiresInSeconds: 604801 })).error.code, 'INVALID_EXPIRATION');
  assert.equal((await s3.uploadFileToS3({ fileName: 'grande.txt', fileText: 'x'.repeat(50 * 1024 * 1024) })).error.code, 'FILE_TOO_LARGE');
  assert.equal(requests.length, 0);
});

test('SMTP verifica salud, envía correo completo y correo sencillo sin JWT', async () => {
  const { client, requests } = clientWithRecorder(() => Response.json({ success: true, message: 'Enviado', data: { id: 'mail-1' } }));
  const mail = createTdMailService(client);
  assert.equal((await mail.checkMailHealth()).success, true);
  assert.equal((await mail.sendMail({ to: ['uno@example.com'], subject: 'Asunto', html: '<b>Hola</b>', attachments: [{ fileName: 'a.txt', contentText: 'Hola' }] })).success, true);
  assert.equal((await mail.sendSimpleMail({ to: 'dos@example.com', subject: 'Asunto', text: 'Hola' })).success, true);
  assert.deepEqual(requests.map(r => new URL(r.url).pathname), ['/api/v1/mail/health', '/api/v1/mail/send', '/api/v1/mail/send']);
  assert.equal(requests.every(r => !r.options.headers?.Authorization), true);
  assert.equal(JSON.parse(requests[1].options.body).attachments[0].contentText, 'Hola');
  assert.equal((await mail.sendSimpleMail({ to: 'dos@example.com', subject: '', text: 'Hola' })).error.code, 'MISSING_SUBJECT');
  assert.equal(requests.length, 3);
});

test('cliente TD normaliza fallos HTTP, red y falta de configuración', async () => {
  const rejected = createTdApiClient({ baseUrl: 'https://td.example/api/v1', fetchImpl: async () => Response.json({ success: false, message: 'No disponible', error: { code: 'DOWN' } }, { status: 503 }) });
  assert.deepEqual(await rejected.request({ path: '/mail/health' }), { success: false, message: 'No disponible', data: null, error: { code: 'DOWN', status: 503, details: { code: 'DOWN' } } });
  const offline = createTdApiClient({ baseUrl: 'https://td.example/api/v1', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await offline.request({ path: '/mail/health' })).error.code, 'TD_UNAVAILABLE');
  const missing = createTdApiClient({ baseUrl: '' });
  assert.equal((await missing.request({ path: '/mail/health' })).error.code, 'TD_NOT_CONFIGURED');
});
