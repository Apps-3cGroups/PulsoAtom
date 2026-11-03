import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildActiveBoard, visibleBoardMarks } from '../src/services/activeBoard.js';
const conversation = (id, extra = {}) => ({ id, country: 'HN', agent: { id: 'a', name: 'Ana' }, startedAt: '2026-11-03T12:00:00Z', evaluated: true, p1: 0, p2: 0, human: 0, marks: [], ...extra });
test('country board groups by assistant ID, keeps every conversation, and puts critical flags first without mutating the input', () => {
  const input = [conversation('ok'), conversation('other-country', { country: 'MX' }), conversation('same-name', { agent: { id: 'b', name: 'Ana' } }), conversation('pending', { evaluated: false }), conversation('critical', { p1: 1 }), conversation('pink', { p2: 1 })];
  const snapshot = structuredClone(input);
  const groups = buildActiveBoard(input, 'HN');
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].conversations.map(c => c.id), ['critical', 'pink', 'pending', 'ok']);
  assert.equal(groups[0].flagged, 2);
  assert.equal(groups[0].pending, 1);
  assert.equal(groups[1].conversations[0].id, 'same-name');
  assert.deepEqual(input, snapshot);
});
test('refutations stay visible but do not count as current flags; coaching and media are omitted', () => {
  const c = conversation('refuted', { marks: ['refuted', 'coaching', 'media'].map(kind => ({ kind })) });
  assert.deepEqual(visibleBoardMarks(c), [{ kind: 'refuted' }]);
  assert.equal(buildActiveBoard([c], 'HN')[0].flagged, 0);
  assert.deepEqual(buildActiveBoard([c], 'GT'), []);
});
