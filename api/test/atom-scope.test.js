import test from 'node:test';
import assert from 'node:assert/strict';
import { AtomReader } from '../src/atom.js';
import { AtomHistoryStore } from '../src/store.js';
import { createState } from '../src/data/seed.js';
import { sourceFingerprint } from '../src/evaluation-context.js';

function fixture(count = 2) {
  const rows = Array.from({ length: count }, (_, index) => ({ IdConversacion: index + 1, IdExternoAtom: `atom-${index + 1}`,
    IdDocumentoVigente: 1000 + index, CodigoPais: 57, ClienteNombre: 'Cliente sintético',
    FechaInicioUtc: new Date('2026-11-06T12:00:00Z'), FechaUltimaActividadUtc: new Date('2026-11-06T12:05:00Z') }));
  const events = rows.map(row => ({ IdDocumento: row.IdDocumentoVigente, IdEvento: `message-${row.IdConversacion}`,
    Texto: 'Consulta sintética.', RolEmisor: 'CLIENTE', TipoOrigen: 'text', FechaHoraUtc: new Date('2026-11-06T12:00:00Z') }));
  const calls = [];
  const reader = Object.create(AtomReader.prototype);
  Object.assign(reader, { cache: null, pending: null, timezone: 'America/Tegucigalpa',
    tables: { conversations: '`conversations`', documents: '`documents`', agents: '`agents`', channels: '`channels`', countries: '`countries`', events: '`events`' },
    pool: { async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.startsWith('SELECT IdDocumento')) return [events.filter(row => parameters.includes(String(row.IdDocumento)))];
      const selected = rows.filter(row => parameters === undefined || parameters.includes(String(row.IdConversacion)));
      if (sql.startsWith('SELECT DISTINCT')) return [selected.length ? [{ code: 57, iso2: 'HN', name: 'Honduras' }] : []];
      return [[...selected].sort((a, b) => b.IdConversacion - a.IdConversacion)];
    } },
  });
  return { reader, rows, events, calls };
}

test('lectura por IDs limita país, conversaciones y eventos mediante parámetros y conserva documento y huella', async () => {
  const { reader, calls } = fixture();
  const scoped = await reader.read({ fresh: true, conversationIds: [2, '2'] });
  assert.deepEqual(scoped.conversations.map(c => c.id), ['2']);
  assert.equal(scoped.conversations[0].sourceDocumentId, '1001');
  assert.deepEqual(scoped.conversations[0].messages.map(m => m.id), ['message-2']);
  assert.equal(calls.length, 3);
  for (const call of calls.slice(0, 2)) {
    assert.match(call.sql, /WHERE c\.IdConversacion IN \(\?\)/);
    assert.deepEqual(call.parameters, ['2']);
  }
  assert.deepEqual(calls[2].parameters, ['1001']);
  const full = await reader.read({ fresh: true });
  assert.equal(sourceFingerprint(scoped.conversations[0]), sourceFingerprint(full.conversations.find(c => c.id === '2')));
  assert.ok(calls.slice(3, 5).every(call => !call.sql.includes('WHERE c.IdConversacion') && call.parameters === undefined));
  const missing = await reader.read({ conversationIds: ['not-present', "2' OR 1=1 --"] });
  assert.deepEqual(missing.conversations, []);
  assert.ok(calls.slice(-2).every(call => !call.sql.includes("2' OR") && call.parameters.includes("2' OR 1=1 --")));
});

test('IDs vacíos no provocan lectura total; entradas inválidas se rechazan antes de consultar', async () => {
  const { reader, calls } = fixture();
  assert.deepEqual((await reader.read({ conversationIds: [] })).conversations, []);
  for (const conversationIds of [null, '2', {}, [''], [undefined], [0], [-1], [1.5], ['x'.repeat(201)], Array(1001).fill('2')]) {
    await assert.rejects(reader.read({ conversationIds }), { code: 'INVALID_CONVERSATION_SCOPE' });
  }
  assert.equal(calls.length, 0);
});

test('selecciones grandes se dividen en consultas acotadas sin duplicar ni perder IDs', async () => {
  const { reader, calls } = fixture(601);
  const selected = await reader.read({ conversationIds: Array.from({ length: 601 }, (_, i) => String(i + 1)) });
  assert.equal(selected.conversations.length, 601);
  assert.equal(new Set(selected.conversations.map(c => c.id)).size, 601);
  assert.deepEqual(selected.conversations.slice(0, 2).map(c => c.id), ['601', '600']);
  assert.equal(selected.countries.length, 1);
  assert.equal(calls.length, 9);
  assert.ok(calls.every(call => call.parameters.length <= 300 && (call.sql.match(/\?/g) || []).length === call.parameters.length));
});

test('lecturas scoped detectan cambios y no esperan ni contaminan la caché global pendiente', async () => {
  const { reader, events } = fixture();
  let finishGlobal;
  const fetch = reader.fetch.bind(reader);
  reader.fetch = options => options?.conversationIds ? fetch(options) : new Promise(resolve => { finishGlobal = resolve; });
  const globalRead = reader.read({ fresh: true });
  const pending = reader.pending;
  const first = await reader.read({ fresh: true, conversationIds: ['2'] });
  assert.equal(reader.pending, pending);
  assert.equal(reader.cache, null);
  const globalValue = { conversations: [{ id: 'global-snapshot' }], countries: [], loadedAt: '2026-11-06T12:00:00Z' };
  finishGlobal(globalValue);
  await globalRead;
  const cached = reader.cache;
  events[1].Texto = 'Contenido actualizado sintético.';
  const second = await reader.read({ conversationIds: ['2'] });
  assert.notEqual(sourceFingerprint(first.conversations[0]), sourceFingerprint(second.conversations[0]));
  assert.equal(reader.cache, cached);
  assert.equal(await reader.read(), globalValue);
});

test('AtomHistoryStore transmite el scope sin guardar transcripciones ni reducir la base persistida', async () => {
  const state = createState(false), requested = [];
  const source = { conversations: [{ id: '2', messages: [{ id: 'message-2', text: 'Sintético' }] }], countries: [], loadedAt: '2026-11-06T12:00:00Z' };
  const store = new AtomHistoryStore({ read: async () => structuredClone(state) }, { read: async options => { requested.push(options); return source; } });
  const scoped = await store.readWithConversations({ fresh: true, conversationIds: ['2'] });
  assert.deepEqual(requested, [{ fresh: true, conversationIds: ['2'] }]);
  assert.equal(scoped.conversations[0].id, '2');
  assert.deepEqual(state.conversations, []);
  assert.equal(scoped.catalog.length, state.catalog.length);
});
