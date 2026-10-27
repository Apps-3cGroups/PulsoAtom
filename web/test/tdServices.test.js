import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadFileToS3, getS3TemporaryUrl, downloadS3File } from '../src/services/tdS3Service.js';
import { checkMailHealth, sendMail, sendSimpleMail } from '../src/services/tdMailService.js';

test('servicios web reutilizan rutas de Pulso y normalizan JSON y blob', async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: 'https://pulso.example' }, dispatchEvent() {} };
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return String(url).includes('/s3/download')
      ? new Response(new Blob(['Hola']), { headers: { 'content-type': 'text/plain' } })
      : Response.json({ success: true, message: 'OK', data: { done: true }, error: null });
  };
  try {
    assert.equal((await uploadFileToS3({ fileName: 'a.txt', fileText: 'Hola' })).success, true);
    assert.equal((await getS3TemporaryUrl({ s3Key: 'a.txt', expiresInSeconds: 900 })).success, true);
    const file = await downloadS3File({ s3Key: 'a.txt' });
    assert.equal(file.success, true);
    assert.equal(await file.data.text(), 'Hola');
    assert.equal((await checkMailHealth()).success, true);
    assert.equal((await sendMail({ to: 'test@example.com', subject: 'Prueba', text: 'Hola' })).success, true);
    assert.equal((await sendSimpleMail({ to: 'test@example.com', subject: 'Prueba', text: 'Hola' })).success, true);
    assert.deepEqual(requests.map(r => new URL(r.url).pathname), [
      '/pulso/api/integrations/td/s3/upload', '/pulso/api/integrations/td/s3/url', '/pulso/api/integrations/td/s3/download',
      '/pulso/api/integrations/td/mail/health', '/pulso/api/integrations/td/mail/send', '/pulso/api/integrations/td/mail/send',
    ]);
    assert.equal(requests.every(r => r.options.credentials === 'same-origin'), true);
  } finally { globalThis.fetch = previousFetch; globalThis.window = previousWindow; }
});
