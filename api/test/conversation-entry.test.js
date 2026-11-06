import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { newToken, tokenHash } from '../src/auth.js';
import { selectConversationEntry } from '../src/conversation-entry.js';

const config = { demo: true, origin: 'http://127.0.0.1:3000', sessionHours: 8, secureCookie: false, timezone: 'America/Tegucigalpa' };
const path = '/pulsoAtom/api/conversation-entry';
const conversation = (id, properties = {}) => ({ id, messages: [], ...properties });

function fixture(conversations, { history = true, historyError = null } = {}) {
  const tokens = Object.fromEntries(['admin', 'supervisor'].map(role => [role, newToken()]));
  const state = {
    users: Object.keys(tokens).map(role => ({ id: role, role, active: true, name: `Usuario sintético ${role}` })),
    sessions: Object.entries(tokens).map(([role, token]) => ({ id: tokenHash(token), userId: role, expiresAt: new Date(Date.now() + 3600000).toISOString() })),
    conversations,
    evaluations: [{ id: 'saved-evaluation', results: [{ value: 1 }] }],
    reviews: [{ id: 'saved-review' }], jobs: [], tasks: [], attempts: [], exposures: [],
  };
  const calls = { history: 0, transaction: 0, evaluation: 0 };
  const store = {
    async read() { return state; },
    async transaction() { calls.transaction++; throw new Error('This read must not persist anything'); },
    ...(history ? { async readWithConversations() { calls.history++; if (historyError) throw historyError; return state; } } : {}),
  };
  const evaluator = { configured: true, async evaluate() { calls.evaluation++; throw new Error('This read must not run AI'); } };
  const app = createApp(store, config, evaluator);
  const get = (query = '', role = 'supervisor') => request(app).get(`${path}${query}`).set('Cookie', `pulso_session=${tokens[role]}`);
  return { app, get, state, calls };
}

test('conversation entry requires authentication before reading the history', async () => {
  const { app, calls } = fixture([conversation('latest')]);
  await request(app).get(path).expect(401);
  assert.deepEqual(calls, { history: 0, transaction: 0, evaluation: 0 });
});

for (const role of ['admin', 'supervisor']) {
  test(`${role} enters the most recently active conversation without exposing or changing results`, async () => {
    const { get, state, calls } = fixture([
      conversation('newer-start', { startedAt: '2026-11-04T15:00:00Z', endedAt: '2026-11-04T15:20:00Z' }),
      conversation('older-reopened', { startedAt: '2026-10-01T15:00:00Z', endedAt: '2026-10-01T16:00:00Z',
        messages: [{ id: 'm1', timestamp: '2026-11-06T14:00:00Z', text: 'Mensaje sintético privado' }],
        client: { name: 'Cliente sintético privado' }, evaluationId: 'saved-evaluation' }),
    ]);
    const before = structuredClone(state);
    const result = await get('', role).expect(200);
    assert.deepEqual(result.body, { conversationId: 'older-reopened' });
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.deepEqual(state, before);
    assert.deepEqual(calls, { history: 1, transaction: 0, evaluation: 0 });
  });
}

test('entry honors an available remembered ID and falls back when it is no longer present', async () => {
  const { get, calls } = fixture([
    conversation('remembered', { startedAt: '2026-10-01T15:00:00Z' }),
    conversation('latest', { lastActivityAt: '2026-11-06T15:00:00Z' }),
  ]);
  assert.deepEqual((await get('?preferredId=%20remembered%20').expect(200)).body, { conversationId: 'remembered' });
  assert.deepEqual((await get('?preferredId=deleted').expect(200)).body, { conversationId: 'latest' });
  assert.deepEqual(calls, { history: 2, transaction: 0, evaluation: 0 });
});

test('entry returns null for an empty history and supports the demo store read path', async () => {
  const empty = fixture([]);
  assert.deepEqual((await empty.get('?preferredId=deleted').expect(200)).body, { conversationId: null });
  const demo = fixture([conversation('demo-case')], { history: false });
  assert.deepEqual((await demo.get().expect(200)).body, { conversationId: 'demo-case' });
  assert.deepEqual(demo.calls, { history: 0, transaction: 0, evaluation: 0 });
});

test('entry rejects malformed or unexpected query parameters without reading history', async () => {
  const { get, calls } = fixture([conversation('case')]);
  for (const query of ['?preferredId=', '?preferredId=%20%20', `?preferredId=${'a'.repeat(201)}`, '?preferredId=a&preferredId=b', '?country=HN']) {
    const response = await get(query).expect(422);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(calls, { history: 0, transaction: 0, evaluation: 0 });
});

test('history failures remain errors rather than becoming an empty or successful selection', async t => {
  t.mock.method(console, 'error', () => {});
  const unavailable = fixture([conversation('case')], { historyError: Object.assign(new Error('private connection detail'), { code: 'ECONNREFUSED' }) });
  const response = await unavailable.get('?preferredId=case').expect(503);
  assert.equal(response.body.error.code, 'DATABASE_UNAVAILABLE');
  assert.equal(Object.hasOwn(response.body, 'conversationId'), false);
  assert.ok(!JSON.stringify(response.body).includes('private connection detail'));
  assert.deepEqual(unavailable.calls, { history: 1, transaction: 0, evaluation: 0 });
});

test('activity selection handles explicit activity, unordered messages, invalid dates and deterministic ties', () => {
  assert.equal(selectConversationEntry([
    conversation('explicit', { lastActivityAt: '2026-11-06T15:00:00Z', startedAt: '2026-10-01T15:00:00Z' }),
    conversation('other', { endedAt: '2026-11-05T15:00:00Z' }),
  ]), 'explicit');
  assert.equal(selectConversationEntry([
    conversation('unordered', { lastActivityAt: 'invalid', endedAt: 'invalid', messages: [
      { timestamp: null }, { timestamp: '2026-11-06T15:00:00Z' }, { timestamp: 'not-a-date' }, { timestamp: '2026-10-01T15:00:00Z' },
    ] }),
    conversation('fallback', { startedAt: '2026-11-05T15:00:00Z' }),
  ]), 'unordered');
  assert.equal(selectConversationEntry([
    conversation('invalid', { startedAt: '', endedAt: null }),
    conversation('fallback', { startedAt: '2026-11-05T15:00:00Z', messages: [{ timestamp: 'invalid' }] }),
  ]), 'fallback');
  const tied = [conversation('b', { endedAt: '2026-11-06T09:00:00-06:00' }), conversation('a', { lastActivityAt: '2026-11-06T15:00:00Z' })];
  assert.equal(selectConversationEntry(tied), 'a');
  assert.equal(selectConversationEntry([...tied].reverse()), 'a');
  assert.equal(selectConversationEntry([conversation('b'), conversation('a')]), 'a');
});
