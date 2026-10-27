import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createState } from '../src/data/seed.js';
import { matchesSomos3cPassword } from '../src/identity.js';

const origin = 'http://127.0.0.1:3000';
const hash = value => createHash('sha512').update(value).digest('hex');
const write = (client, method, path, body) => client[method](`/pulso/api${path}`).set('Origin', origin).send(body);

test('el hash Somos3C se verifica sin aceptar formatos desconocidos', () => {
  assert.equal(matchesSomos3cPassword(hash('clave segura'), 'clave segura'), true);
  assert.equal(matchesSomos3cPassword(hash('clave segura'), 'otra clave'), false);
  assert.equal(matchesSomos3cPassword('no-es-un-hash', 'clave segura'), false);
});

test('el superadministrador de origen concede y revoca acceso desde Pulso', async () => {
  let state = createState(false);
  const source = new Map([
    [1, { id: 1, username: 'jefe', name: 'Jefe', active: true, changeRequired: false, blocked: false, sourceRoles: ['super_admin'], passwordHash: hash('clave-jefe') }],
    [2, { id: 2, username: 'supervisor', name: 'Supervisora', active: true, changeRequired: false, blocked: false, sourceRoles: [], passwordHash: hash('clave-supervisora') }],
  ]);
  const identity = {
    lookup: async username => [...source.values()].find(user => user.username === username) || null,
    byId: async id => source.get(Number(id)) || null,
  };
  const store = { async read() { return structuredClone(state); }, async transaction(fn) { const draft = structuredClone(state); const result = await fn(draft); state = draft; return result; } };
  const app = createApp(store, { demo: false, origin, sessionHours: 8, secureCookie: false, timezone: 'America/Tegucigalpa' }, { configured: false }, identity);
  const admin = request.agent(app);
  const other = request.agent(app);
  await write(other, 'post', '/auth/login', { username: 'supervisor', password: 'clave-supervisora' }).expect(403);
  source.get(1).changeRequired = true;
  await write(admin, 'post', '/auth/login', { username: 'jefe', password: 'clave-jefe' }).expect(403);
  source.get(1).changeRequired = false;
  await write(admin, 'post', '/auth/login', { username: 'jefe', password: 'clave-jefe' }).expect(200);
  const lookup = await write(admin, 'post', '/access/lookup', { username: 'supervisor' }).expect(200);
  assert.equal(lookup.body.user.id, 2);
  assert.equal(JSON.stringify(lookup.body).includes('passwordHash'), false);
  const grant = await write(admin, 'post', '/access/grants', { externalId: 2, role: 'supervisor' }).expect(201);
  assert.equal(grant.body.grant.role, 'supervisor');
  await write(other, 'post', '/auth/login', { username: 'supervisor', password: 'clave-supervisora' }).expect(200);
  await other.get('/pulso/api/catalog').expect(200);
  source.get(2).changeRequired = true;
  await other.get('/pulso/api/catalog').expect(401);
  source.get(2).changeRequired = false;
  await write(other, 'post', '/access/lookup', { username: 'jefe' }).expect(403);
  await write(admin, 'patch', '/access/grants/somos3c%3A2', { active: false }).expect(200);
  await other.get('/pulso/api/catalog').expect(401);
  assert.equal((await store.read()).users.find(user => user.externalId === 2).passwordHash, undefined);
});

test('una cuenta por correo de tblPersonas usa el permiso propio de Pulso', async () => {
  let state = createState(false);
  state.users.push({ id: 'somos3c-person:42', externalId: 42, externalGrant: true, email: 'somos3c-person-42@pulso.local', name: 'Persona', role: 'admin', active: true });
  const person = { id: 42, username: 'persona@example.test', name: 'Persona', active: true, blocked: false, changeRequired: false, sourceRoles: [], passwordHash: hash('clave-correcta') };
  const identity = { mode: 'person-email', lookup: async email => email === person.username ? person : null, byId: async id => Number(id) === 42 ? person : null };
  const store = { async read() { return structuredClone(state); }, async transaction(fn) { const draft = structuredClone(state); const result = await fn(draft); state = draft; return result; } };
  const app = createApp(store, { demo: false, origin, sessionHours: 8, secureCookie: false, timezone: 'America/Tegucigalpa' }, { configured: false }, identity);
  const client = request.agent(app);
  assert.equal((await client.get('/pulso/api/meta')).body.authMode, 'somos3c-email');
  await write(client, 'post', '/auth/login', { username: person.username, password: 'clave-correcta' }).expect(200);
  assert.equal((await client.get('/pulso/api/auth/me')).body.user.role, 'admin');
  person.active = false;
  await client.get('/pulso/api/auth/me').expect(401);
  assert.equal(state.users[0].passwordHash, undefined);
});
