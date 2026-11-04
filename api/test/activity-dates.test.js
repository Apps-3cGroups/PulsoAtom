import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mapAtomConversation } from '../src/atom.js';
import { createState } from '../src/data/seed.js';
import { filteredConversations, listQuerySchema } from '../src/domain.js';
import { sourceFingerprint } from '../src/evaluation-context.js';
import { createApp } from '../src/app.js';

function conversation(id, start, activity, ingestion = '2026-11-06T18:00:00Z') {
  return mapAtomConversation({ IdConversacion: id, IdExternoAtom: `synthetic-${id}`, CodigoPais: 70,
    IdAsesorActual: 1, AsesorNombre: 'Asesor sintético', ClienteNombre: `Cliente de prueba ${id}`,
    FechaInicioUtc: start, FechaUltimaActividadUtc: activity, FechaCreacionUtc: ingestion, FechaActualizacionUtc: ingestion,
  }, [], { code: 'HN', name: 'Honduras' }, 'America/Tegucigalpa');
}
function fixture() {
  const state = createState(false);
  state.conversations = [
    conversation('oct-reopened', '2026-10-30T12:00:00Z', '2026-11-04T02:00:00Z'),
    conversation('older-latest', '2026-10-29T12:00:00Z', '2026-11-04T15:00:00Z'),
    conversation('nov-start', '2026-11-01T12:00:00Z', null),
  ];
  return state;
}

test('Atom conserva inicio y fecha local de última actividad sin usar la fecha de ingesta', () => {
  const c = conversation('sample', new Date('2026-10-30T12:00:00Z'), new Date('2026-11-04T02:00:00Z'));
  assert.equal(c.date, '2026-10-30'); assert.equal(c.startedAt, '2026-10-30T12:00:00.000Z');
  assert.equal(c.activityDate, '2026-11-03'); assert.equal(c.lastActivityAt, '2026-11-04T02:00:00.000Z');
  assert.equal(c.sourceUpdatedAt, '2026-11-06T18:00:00.000Z');
  const sqlDates = conversation('sql-date', '2026-10-30 12:00:00', '2026-11-04 02:00:00');
  assert.equal(sqlDates.activityDate, c.activityDate);
  const offset = conversation('offset-date', '2026-10-30T06:00:00-06:00', '2026-11-03T20:00:00-06:00');
  assert.equal(offset.lastActivityAt, c.lastActivityAt);
});

test('si no hay última actividad se usa el inicio, nunca fecha de carga ni actualización', () => {
  const c = conversation('missing-activity', '2026-10-30T12:00:00Z', null);
  assert.equal(c.activityDate, '2026-10-30'); assert.equal(c.lastActivityAt, c.startedAt);
  assert.equal(c.endedAt, c.startedAt);
  const state = fixture();
  delete state.conversations[2].activityDate; delete state.conversations[2].lastActivityAt;
  const result = filteredConversations(state, { dateBasis: 'activity', from: '2026-11-01', to: '2026-11-01' });
  assert.equal(result.length, 1); assert.equal(result[0].displayDate, '2026-11-01');
});

test('filtro y orden por actividad son opt-in y no sobrescriben la fecha histórica', () => {
  const state = fixture(), before = structuredClone(state);
  assert.equal(listQuerySchema.parse({}).dateBasis, 'started');
  assert.throws(() => listQuerySchema.parse({ dateBasis: 'ingestion' }));
  const query = { from: '2026-11-01', to: '2026-11-04' };
  assert.deepEqual(filteredConversations(state, query).map(c => c.id), ['nov-start']);
  const activity = filteredConversations(state, { ...query, dateBasis: 'activity' });
  assert.deepEqual(activity.map(c => c.id), ['older-latest', 'oct-reopened', 'nov-start']);
  assert.deepEqual(activity.map(c => c.displayDate), ['2026-11-04', '2026-11-03', '2026-11-01']);
  assert.equal(activity[0].date, '2026-10-29');
  assert.equal(activity[0].displayAt, activity[0].lastActivityAt);
  assert.equal(activity[0].dateBasis, 'activity');
  const started = filteredConversations(state, { dateBasis: 'started' });
  assert.deepEqual(started.map(c => c.id), ['nov-start', 'oct-reopened', 'older-latest']);
  assert.equal(started[0].displayDate, started[0].date);
  assert.equal(filteredConversations(state, { ...query, dateBasis: 'activity', country: 'CR' }).length, 0);
  assert.deepEqual(state, before);
});

test('la fecha de visualización no cambia la huella del contenido evaluado', () => {
  const c = fixture().conversations[0], before = sourceFingerprint(c);
  c.activityDate = '2026-11-04'; c.lastActivityAt = '2026-11-04T16:00:00Z';
  assert.equal(sourceFingerprint(c), before);
});

test('bootstrap separa ambos rangos y Resumen/Histórico/Búsqueda aceptan actividad sin ejecutar IA', async () => {
  const state = fixture();
  state.users = [{ id: 'demo-admin', name: 'Administración sintética', role: 'admin', active: true }];
  state.countries = [{ code: 'HN', name: 'Honduras' }];
  const store = { read: async () => structuredClone(state), transaction: async fn => fn(state) };
  let modelCalls = 0;
  const evaluator = { configured: true, evaluate: async () => { modelCalls++; throw new Error('No se debe evaluar al consultar'); } };
  const app = createApp(store, { demo: true, basePath: '/pulsoAtom', origin: 'http://127.0.0.1:3000', timezone: 'America/Tegucigalpa', sessionHours: 1, secureCookie: false }, evaluator);
  const client = request.agent(app);
  await client.post('/pulsoAtom/api/auth/demo').send({ role: 'admin' }).expect(200);
  const bootstrap = await client.get('/pulsoAtom/api/bootstrap').expect(200);
  assert.deepEqual(bootstrap.body.dateRange, { min: '2026-10-29', max: '2026-11-01' });
  assert.deepEqual(bootstrap.body.activityDateRange, { min: '2026-11-01', max: '2026-11-04' });
  const search = '?dateBasis=activity&from=2026-11-03&to=2026-11-04';
  const summary = await client.get(`/pulsoAtom/api/summary${search}`).expect(200);
  assert.equal(summary.body.metrics.total, 2);
  assert.deepEqual(summary.body.conversations.map(c => c.displayDate), ['2026-11-04', '2026-11-03']);
  assert.equal(summary.body.conversations[0].date, '2026-10-29');
  const legacy = await client.get('/pulsoAtom/api/summary?from=2026-11-03&to=2026-11-04').expect(200);
  assert.equal(legacy.body.metrics.total, 0);
  for (const path of ['conversations', 'search']) {
    const response = await client.get(`/pulsoAtom/api/${path}${search}`).expect(200);
    assert.equal(response.body.total, 2);
    assert.deepEqual(response.body.items.map(c => c.id), ['older-latest', 'oct-reopened']);
    assert.equal(response.body.items[0].displayDate, '2026-11-04');
  }
  assert.equal(modelCalls, 0); assert.equal(state.evaluations.length, 0);
});
