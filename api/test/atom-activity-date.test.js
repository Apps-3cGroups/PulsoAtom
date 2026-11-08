import assert from 'node:assert/strict';
import test from 'node:test';
import { mapAtomConversation } from '../src/atom.js';
import { sourceFingerprint } from '../src/evaluation-context.js';
import { filteredConversations, summarize } from '../src/domain.js';
import { createState } from '../src/data/seed.js';
import { defaultDateRange } from '../../web/src/services/dateRange.js';

const timezone = 'America/Tegucigalpa';
const country = { code: 'HN', name: 'Honduras' };
const source = overrides => ({ IdConversacion: 1, IdExternoAtom: 'synthetic-1', CodigoPais: 1,
  FechaInicioUtc: new Date('2026-10-31T15:00:00Z'), FechaUltimaActividadUtc: new Date('2026-11-06T16:00:00Z'), ...overrides });
const event = (id, timestamp) => ({ IdEvento: id, TipoOrigen: 'text', RolEmisor: 'CLIENTE', Texto: `Mensaje sintético ${id}`, FechaHoraUtc: new Date(timestamp) });

test('a chat started in October appears on its November activity day without changing its evaluated content', () => {
  const conversation = mapAtomConversation(source(), [event(1, '2026-10-31T15:00:00Z'), event(2, '2026-11-06T15:00:00Z')], country, timezone);
  assert.equal(conversation.date, '2026-11-06');
  assert.equal(conversation.startedAt, '2026-10-31T15:00:00.000Z');
  assert.equal(conversation.lastActivityAt, '2026-11-06T16:00:00.000Z');
  assert.deepEqual(conversation.messages.map(m => m.timestamp), ['2026-10-31T15:00:00.000Z', '2026-11-06T15:00:00.000Z']);
  assert.equal(sourceFingerprint(conversation), sourceFingerprint({ ...conversation, date: '2026-10-31' }));
  const state = createState(false); state.conversations = [conversation];
  assert.equal(filteredConversations(state, { from: '2026-11-06', to: '2026-11-06' }).length, 1);
  assert.equal(filteredConversations(state, { from: '2026-10-31', to: '2026-10-31' }).length, 0);
});

test('navigation week ends on the local activity day, including cross-month and UTC-midnight boundaries', () => {
  const c = mapAtomConversation(source({ FechaUltimaActividadUtc: new Date('2026-11-07T01:30:00Z') }), [], country, timezone);
  assert.equal(c.date, '2026-11-06');
  assert.deepEqual(defaultDateRange(c.date, timezone, new Date('2026-11-08T05:44:00Z')), { from: '2026-10-31', to: '2026-11-06' });
  const january = mapAtomConversation(source({ FechaInicioUtc: new Date('2026-12-31T16:00:00Z'), FechaUltimaActividadUtc: new Date('2027-01-02T00:30:00Z') }), [], country, timezone);
  assert.equal(january.date, '2027-01-01');
  assert.deepEqual(defaultDateRange(january.date, timezone), { from: '2026-12-26', to: '2027-01-01' });
});

test('missing or invalid activity metadata falls back to the latest message, not array order or start date', () => {
  for (const value of [null, '', 'not-a-date', new Date(NaN)]) {
    const conversation = mapAtomConversation(source({ FechaUltimaActividadUtc: value }),
      [event(2, '2026-11-06T15:00:00Z'), event(1, '2026-10-31T15:00:00Z')], country, timezone);
    assert.equal(conversation.date, '2026-11-06');
    assert.equal(conversation.lastActivityAt, null);
    assert.equal(conversation.startedAt, '2026-10-31T15:00:00.000Z');
    assert.deepEqual(conversation.messages.map(m => m.id), ['2', '1']);
  }
  const empty = mapAtomConversation(source({ FechaUltimaActividadUtc: null }), [], country, timezone);
  assert.equal(empty.date, '2026-10-31');
  assert.equal(empty.endedAt, empty.startedAt);
});

test('default summary scope retains every conversation in its activity window regardless of evaluation or flags', () => {
  const state = createState(false);
  state.conversations = [
    mapAtomConversation(source({ IdConversacion: 1 }), [], country, timezone),
    mapAtomConversation(source({ IdConversacion: 2, FechaInicioUtc: new Date('2026-11-05T16:00:00Z') }), [], country, timezone),
    mapAtomConversation(source({ IdConversacion: 3, FechaUltimaActividadUtc: new Date('2026-10-30T15:00:00Z') }), [], country, timezone),
  ];
  const latest = state.conversations.map(c => c.date).sort().at(-1);
  const result = filteredConversations(state, defaultDateRange(latest, timezone));
  assert.deepEqual(new Set(result.map(c => c.id)), new Set(['1', '2']));
  assert.equal(summarize(result).total, 2);
  assert.equal(summarize(result).pending, 2);
});
