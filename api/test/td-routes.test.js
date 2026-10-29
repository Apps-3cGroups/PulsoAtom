import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createState } from '../src/data/seed.js';
import { tokenHash } from '../src/auth.js';

test('API real de Pulso expone S3 y SMTP solo a una sesión administradora', async () => {
  const state = createState(false);
  const token = 'A'.repeat(43);
  state.users.push({ id: 'admin', name: 'Admin', email: 'admin@example.com', role: 'admin', active: true });
  state.sessions.push({ id: tokenHash(token), userId: 'admin', expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const store = { read: async () => state, transaction: async fn => fn(state) };
  const calls = [];
  const ok = data => ({ success: true, message: 'OK', data, error: null });
  const tdServices = {
    s3: {
      uploadFileToS3: async body => { calls.push(['upload', body]); return ok({ s3Key: 'nuevo.txt' }); },
      getS3TemporaryUrl: async query => { calls.push(['url', query]); return ok({ url: 'https://signed.example/nuevo.txt' }); },
      downloadS3File: async query => { calls.push(['download', query]); return ok({ bytes: Buffer.from('Hola'), contentType: 'text/plain' }); },
    },
    mail: {
      checkMailHealth: async () => { calls.push(['health']); return ok({ connected: true }); },
      sendMail: async body => { calls.push(['send', body]); return ok({ id: 'mail-1' }); },
    },
  };
  const app = createApp(store, { demo: false, origin: 'https://pulso.example', sessionHours: 8, secureCookie: true, timezone: 'America/Tegucigalpa' }, undefined, null, tdServices);
  const admin = request.agent(app);
  const auth = req => req.set('Cookie', `pulso_session=${token}`);
  const root = '/pulsoAtom/api/integrations/td';
  await request(app).get(`${root}/mail/health`).expect(401);
  assert.equal((await auth(admin.get(`${root}/mail/health`)).expect(200)).body.data.connected, true);
  assert.equal((await auth(admin.post(`${root}/s3/upload`)).set('Origin', 'https://pulso.example').send({ fileName: 'a.txt', fileText: 'Hola' }).expect(200)).body.data.s3Key, 'nuevo.txt');
  assert.equal((await auth(admin.get(`${root}/s3/url?s3Key=nuevo.txt&expiresInSeconds=900`)).expect(200)).body.data.url, 'https://signed.example/nuevo.txt');
  const download = await auth(admin.get(`${root}/s3/download?s3Key=nuevo.txt`)).expect(200);
  assert.equal(download.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(download.headers['content-disposition'], /attachment/);
  assert.equal(download.text, 'Hola');
  assert.equal((await auth(admin.post(`${root}/mail/send`)).set('Origin', 'https://pulso.example').send({ to: 'test@example.com', subject: 'Prueba', text: 'Hola' }).expect(200)).body.data.id, 'mail-1');
  assert.deepEqual(calls.map(([name]) => name), ['health', 'upload', 'url', 'download', 'send']);
});
