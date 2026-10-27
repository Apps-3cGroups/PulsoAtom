import assert from 'node:assert/strict';
import test from 'node:test';
import { mapAtomConversation } from '../src/atom.js';
import { AtomHistoryStore } from '../src/store.js';
import { createState } from '../src/data/seed.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import request from 'supertest';

test('Atom se transforma en conversación pendiente, con país de catálogo y sin inventar teléfono ni evaluación', () => {
  const conversation = mapAtomConversation({
    IdConversacion: 9, IdExternoAtom: 'atom-9', CodigoPais: 57, IdAsesorActual: 4,
    AsesorNombre: 'Asesor de prueba', ClienteNombre: 'Cliente de prueba', CanalNombre: 'Chat',
    FechaInicioUtc: new Date('2026-10-21T02:15:00Z'), FechaUltimaActividadUtc: new Date('2026-10-21T02:20:00Z'),
  }, [
    { IdEvento: 10, TipoOrigen: 'text', RolEmisor: 'CLIENTE', Texto: 'Hola', FechaHoraUtc: new Date('2026-10-21T02:15:00Z') },
    { IdEvento: 11, TipoOrigen: 'file', RolEmisor: 'ASESOR', Texto: null, FechaHoraUtc: new Date('2026-10-21T02:16:00Z') },
    { IdEvento: 12, TipoOrigen: 'log', RolEmisor: 'SISTEMA', Texto: 'Interno', FechaHoraUtc: new Date('2026-10-21T02:17:00Z') },
    { IdEvento: 13, TipoOrigen: 'text', RolEmisor: 'ASESOR', DeOrigen: 'Cliente de prueba', Texto: '¿Está disponible?', FechaHoraUtc: new Date('2026-10-21T02:18:00Z') },
  ], { code: 'CR', name: 'Costa Rica' }, 'America/Tegucigalpa');
  assert.equal(conversation.id, '9');
  assert.equal(conversation.country, 'CR');
  assert.equal(conversation.date, '2026-10-20');
  assert.equal(conversation.evaluationId, null);
  assert.equal(conversation.completed, false);
  assert.equal(conversation.client.phoneLast4, null);
  assert.deepEqual(conversation.messages.map(item => item.actor), ['cliente', 'humano', 'cliente']);
  assert.deepEqual(conversation.media, ['archivo']);
});

test('el histórico de Atom se agrega a las lecturas y no se guarda en la base propia', async () => {
  const stored = createState(false);
  const base = {
    read: async () => structuredClone(stored),
    transaction: async fn => { const draft = structuredClone(stored); const result = await fn(draft); stored.reviews = draft.reviews; return result; },
    close: async () => {},
  };
  const source = { countries: [{ code: 'CR', name: 'Costa Rica' }], conversations: [{ id: '9', messages: [{ id: '10', text: 'Hola' }] }], loadedAt: '2026-10-27T12:00:00Z' };
  const store = new AtomHistoryStore(base, { read: async () => source, close: async () => {} });
  const state = await store.readWithConversations();
  assert.equal(state.conversations[0].messages[0].text, 'Hola');
  assert.equal(state.metadata.source, 'Atom');
  assert.deepEqual(state.countries, source.countries);
  await store.transactionWithConversations(draft => { assert.equal(draft.conversations[0].id, '9'); return null; });
  assert.deepEqual(stored.conversations, []);
});

test('las rutas reales muestran el país y los mensajes de Atom sin presentar evaluaciones simuladas', async () => {
  let stored = createState(false);
  stored.users.push({ id: 'admin-test', name: 'Admin', email: 'admin@example.test', role: 'admin', active: true, passwordHash: hashPassword('long-test-password') });
  const base = {
    read: async () => structuredClone(stored),
    transaction: async fn => { const draft = structuredClone(stored); const result = await fn(draft); stored = draft; return result; },
    close: async () => {},
  };
  const conversation = mapAtomConversation({
    IdConversacion: 9, IdExternoAtom: 'atom-9', CodigoPais: 57, IdAsesorActual: 4,
    AsesorNombre: 'Asesor de prueba', ClienteNombre: 'Cliente de prueba', CanalNombre: 'Chat',
    FechaInicioUtc: new Date('2026-10-21T02:15:00Z'), FechaUltimaActividadUtc: new Date('2026-10-21T02:20:00Z'),
  }, [{ IdEvento: 10, TipoOrigen: 'text', RolEmisor: 'CLIENTE', Texto: 'Necesito seguimiento', FechaHoraUtc: new Date('2026-10-21T02:15:00Z') }], { code: 'CR', name: 'Costa Rica' }, 'America/Tegucigalpa');
  const source = { conversations: [conversation], countries: [{ code: 'CR', name: 'Costa Rica' }], loadedAt: '2026-10-27T12:00:00Z' };
  const store = new AtomHistoryStore(base, { read: async () => source, close: async () => {} });
  const app = createApp(store, { demo: false, origin: 'http://127.0.0.1:3000', sessionHours: 8, secureCookie: false, timezone: 'America/Tegucigalpa' });
  const client = request.agent(app);
  await client.post('/pulso/api/auth/login').set('Origin', 'http://127.0.0.1:3000').send({ email: 'admin@example.test', password: 'long-test-password' }).expect(200);
  const bootstrap = await client.get('/pulso/api/bootstrap').expect(200);
  assert.deepEqual(bootstrap.body.countries, [{ code: 'CR', name: 'Costa Rica' }]);
  const history = await client.get('/pulso/api/conversations?country=CR').expect(200);
  assert.equal(history.body.total, 1);
  assert.equal(history.body.items[0].evaluated, false);
  const search = await client.get('/pulso/api/search?q=seguimiento').expect(200);
  assert.equal(search.body.items[0].excerpt.messageId, '10');
  const detail = await client.get('/pulso/api/conversations/9').expect(200);
  assert.equal(detail.body.conversation.messages[0].text, 'Necesito seguimiento');
  assert.equal(detail.body.conversation.evaluation, null);
});

test('un lote a demanda crea resultados reales y los muestra en la conversación', async () => {
  const previousFlag = process.env.OPENAI_EVALUATION_ENABLED;
  process.env.OPENAI_EVALUATION_ENABLED = 'true';
  try {
    let stored = createState(false);
    stored.users.push({ id: 'admin-batch', name: 'Admin', email: 'batch@example.test', role: 'admin', active: true, passwordHash: hashPassword('long-test-password') });
    const base = {
      read: async () => structuredClone(stored),
      transaction: async fn => { const draft = structuredClone(stored); const result = await fn(draft); stored = draft; return result; },
      close: async () => {},
    };
    const conversation = mapAtomConversation({ IdConversacion: 10, IdExternoAtom: 'atom-10', CodigoPais: 57,
      FechaInicioUtc: new Date('2026-10-21T02:15:00Z'), FechaFinUtc: new Date('2026-10-21T02:20:00Z'), FechaUltimaActividadUtc: new Date('2026-10-21T02:20:00Z') },
    [{ IdEvento: 100, TipoOrigen: 'text', RolEmisor: 'CLIENTE', Texto: 'Voy a cancelar mi pedido.', FechaHoraUtc: new Date('2026-10-21T02:15:00Z') }],
    { code: 'CR', name: 'Costa Rica' }, 'America/Tegucigalpa');
    const store = new AtomHistoryStore(base, { read: async () => ({ conversations: [conversation], countries: [{ code: 'CR', name: 'Costa Rica' }], loadedAt: '2026-10-27T12:00:00Z' }), close: async () => {} });
    const evaluator = { configured: true, evaluate: async (_conversation, variables) => ({ model: 'mock', responseId: 'mock-response', results: variables.map(v => ({ variableId: v.id, status: 'evaluado', value: v.id === 'cliente_amenazo_cancelar' ? 1 : 0, reason: 'Prueba local.', evidence: v.id === 'cliente_amenazo_cancelar' ? [{ messageId: '100', quote: 'Voy a cancelar mi pedido.' }] : [] })) }) };
    const app = createApp(store, { demo: false, origin: 'http://127.0.0.1:3000', sessionHours: 8, secureCookie: false, timezone: 'America/Tegucigalpa' }, evaluator);
    const client = request.agent(app);
    await client.post('/pulso/api/auth/login').set('Origin', 'http://127.0.0.1:3000').send({ email: 'batch@example.test', password: 'long-test-password' }).expect(200);
    const started = await client.post('/pulso/api/evaluations').set('Origin', 'http://127.0.0.1:3000').send({ scope: 'new', max: 5 }).expect(202);
    assert.equal(started.body.job.total, 1);
    for (let attempt = 0; attempt < 20 && stored.jobs[0].status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(stored.jobs[0].status, 'completed');
    const detail = await client.get('/pulso/api/conversations/10').expect(200);
    assert.equal(detail.body.conversation.evaluated, true);
    assert.equal(detail.body.conversation.p1, 1);
    assert.equal(stored.conversations.length, 0);
  } finally {
    if (previousFlag === undefined) delete process.env.OPENAI_EVALUATION_ENABLED;
    else process.env.OPENAI_EVALUATION_ENABLED = previousFlag;
  }
});
