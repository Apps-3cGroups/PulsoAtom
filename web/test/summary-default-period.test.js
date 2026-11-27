import test from 'node:test';
import assert from 'node:assert/strict';
import { summarySelectionParams, reviewSelectionId, selectedReview } from '../src/services/reviewSelection.js';
import { resolveSummaryRange } from '../src/services/summaryDates.js';
import { conversationLink, conversationReturn } from '../src/services/conversationNavigation.js';

const selection = { id: 'review94', from: '2026-11-17', to: '2026-11-19', count: 94 };

test('an empty summary uses the three most recent complete local days', () => {
  const original = new URLSearchParams();
  const next = summarySelectionParams(original);
  assert.equal(original.size, 0);
  assert.deepEqual(Object.fromEntries(next), { reviewSelection: 'all', days: '3' });
  assert.equal(reviewSelectionId(next), undefined);
  assert.equal(selectedReview(next, selection), null);
  const days = next.get('days');
  const now = new Date('2026-11-28T05:59:59Z');
  assert.deepEqual(resolveSummaryRange({ days, now }), {
    from: '2026-11-24', to: '2026-11-26', preset: 3, totalDays: 3,
  });
  assert.deepEqual(resolveSummaryRange({ days, now: new Date('2026-11-28T06:00:00Z') }), {
    from: '2026-11-25', to: '2026-11-27', preset: 3, totalDays: 3,
  });
});

test('every explicit URL parameter prevents the new default, including opt-outs and old return links', () => {
  for (const query of [
    'days=1', 'days=3', 'days=30', 'country=NI', 'countries=HN,CR', 'figures=',
    'from=2026-11-04&to=2026-11-06', 'from=2026-11-10', 'completion=all',
    'completion=both', 'reviewSelection=all', 'reviewSelection=review94', 'reviewSelection=unknown',
    'dateBasis=started', 'agreement=both', 'page=2', 'meetingPeriod=meeting-volume-20261125',
  ]) {
    const original = new URLSearchParams(query);
    const next = summarySelectionParams(original);
    assert.equal(next.toString(), original.toString(), query);
    const returnTo = `/?${original}`;
    const detail = new URL(conversationLink('example', returnTo), 'https://pulso.invalid');
    assert.equal(conversationReturn(detail.searchParams).to, returnTo);
  }
});
