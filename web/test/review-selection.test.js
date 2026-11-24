import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSelectionId, summarySelectionParams, selectedReview, withSummaryPeriod, reviewSelectionSourceNote } from '../src/services/reviewSelection.js';
import { figureKinds, filterSummaryConversations, summaryMetrics } from '../src/services/summaryFilters.js';
import { buildSummaryLanes } from '../src/services/summaryMap.js';
import { summaryDayWindow } from '../src/services/summaryDates.js';
import { conversationLink, conversationReturn } from '../src/services/conversationNavigation.js';

const selection = { id: 'review94', from: '2026-11-17', to: '2026-11-19', count: 94 };
test('the historical correction count stays distinct from later source changes', () => {
  assert.match(reviewSelectionSourceNote({ ...selection, sourceChangedCount: 69, timeCorrectionCount: 68 }), /^68 conversaciones/);
  assert.doesNotMatch(reviewSelectionSourceNote({ ...selection, sourceChangedCount: 69 }), /69|corrección de horas/);
});
test('only an unfiltered entry adopts the server selection; explicit filters and opt-out survive refresh', () => {
  const initial = new URLSearchParams();
  const resolved = summarySelectionParams(initial, selection);
  assert.equal(initial.size, 0);
  assert.equal(reviewSelectionId(resolved), selection.id);
  assert.equal(selectedReview(resolved, selection), selection);
  assert.equal(summarySelectionParams(initial, undefined).size, 0);
  for (const query of ['days=3', 'countries=HN', 'figures=', 'from=2026-11-17&to=2026-11-19', 'reviewSelection=all', 'reviewSelection=unknown']) {
    assert.equal(summarySelectionParams(new URLSearchParams(query), selection).toString(), query.replaceAll(',', '%2C'));
    assert.equal(selectedReview(new URLSearchParams(query), selection), null);
  }
  // An invalid identifier must reach the server for validation, not silently fall back.
  assert.equal(reviewSelectionId(new URLSearchParams('reviewSelection=unknown')), 'unknown');
});

test('all normal periods leave the selection while preserving adjustable country and exception filters', () => {
  for (const days of [1, 3, 30]) {
    const next = withSummaryPeriod(new URLSearchParams('reviewSelection=review94&from=2026-11-17&to=2026-11-19&countries=HN,PA&figures=critical'), days);
    assert.equal(next.get('reviewSelection'), 'all');
    assert.equal(reviewSelectionId(next), undefined);
    assert.equal(next.get('days'), String(days));
    assert.equal(next.get('countries'), 'HN,PA');
    assert.equal(next.get('figures'), 'critical');
    assert.equal(next.has('from'), false);
    assert.equal(next.has('to'), false);
    assert.equal(summarySelectionParams(next, selection).toString(), next.toString());
  }
});

test('all 94 members remain visible by default including no flags, pending reviews, changed sources and errors', () => {
  const conversations = Array.from({ length: 94 }, (_, index) => ({
    id: String(index), country: 'HN', agent: { id: 'a', name: 'Asistente' },
    evaluated: index !== 0, evaluationStatus: index === 0 ? 'not_evaluated' : index === 1 ? 'review_pending' : index === 2 ? 'partial' : 'evaluated',
    sourceChanged: index < 68, evaluationErrors: index === 2 ? 1 : 0,
    displayDate: selection.from, displayAt: '2026-11-17T12:00:00Z', activityAt: '2026-11-24T12:00:00Z', marks: [],
  }));
  const shown = filterSummaryConversations(conversations, figureKinds, { includePending: true });
  assert.equal(summaryMetrics(shown).total, 94);
  assert.equal(shown.filter(row => row.sourceChanged).length, 68);
  assert.equal(shown.find(row => row.id === '2').evaluationErrors, 1);
  const groups = buildSummaryLanes(shown, [{ code: 'HN', name: 'Honduras' }], summaryDayWindow(selection).days);
  assert.equal(groups[0].agents[0].byDay[selection.from].length, 94, 'new activity does not move frozen selection days');
  assert.equal(filterSummaryConversations(conversations, figureKinds).length, 92, 'ordinary summary behavior stays intact');
  assert.deepEqual(filterSummaryConversations(conversations, ['critical'], { includePending: true }), []);
  assert.deepEqual(filterSummaryConversations(conversations, [], { includePending: true }), []);
});

test('selection reaches details from summary and paged history while the full return URL survives', () => {
  for (const source of ['/?reviewSelection=review94&countries=HN&figures=', '/historico?reviewSelection=review94&country=HN&page=2&q=cliente']) {
    const detail = new URL(conversationLink('chat 1', source, 'message 1'), 'https://pulso.invalid');
    assert.equal(detail.searchParams.get('reviewSelection'), selection.id);
    assert.equal(detail.searchParams.get('message'), 'message 1');
    assert.equal(conversationReturn(detail.searchParams).to, source);
  }
  for (const source of ['/?reviewSelection=all', 'https://example.com/?reviewSelection=review94', '/unrecognized?reviewSelection=review94']) {
    const detail = new URL(conversationLink('chat1', source), 'https://pulso.invalid');
    assert.equal(detail.searchParams.has('reviewSelection'), false);
  }
});
