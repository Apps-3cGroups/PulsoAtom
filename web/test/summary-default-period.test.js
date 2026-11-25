import test from 'node:test';
import assert from 'node:assert/strict';
import { meetingPeriodSnapshot } from '../src/data/meetingPeriods.js';
import { summarySelectionParams, reviewSelectionId, selectedReview } from '../src/services/reviewSelection.js';
import { conversationLink, conversationReturn } from '../src/services/conversationNavigation.js';

const period = meetingPeriodSnapshot.periods.find(p => p.id === meetingPeriodSnapshot.defaultPeriodId);
const selection = { id: 'review94', from: '2026-11-17', to: '2026-11-19', count: 94 };

test('an empty summary uses the requested meeting period regardless of the published sample', () => {
  assert.ok(period, 'the configured default identifies an available meeting preset');
  for (const configuredPeriod of meetingPeriodSnapshot.periods) for (const published of [undefined, selection, { ...selection, id: 'review214', count: 214 }]) {
    const original = new URLSearchParams();
    const next = summarySelectionParams(original, published, configuredPeriod);
    assert.equal(original.size, 0);
    assert.deepEqual(Object.fromEntries(next), {
      reviewSelection: 'all', from: configuredPeriod.from, to: configuredPeriod.to,
      meetingPeriod: configuredPeriod.id, completion: 'both',
    });
    assert.equal(reviewSelectionId(next), undefined);
    assert.equal(selectedReview(next, published), null);
  }
});

test('every explicit URL parameter prevents the new default, including opt-outs and old return links', () => {
  for (const query of [
    'days=1', 'days=3', 'days=30', 'country=NI', 'countries=HN,CR', 'figures=',
    'from=2026-11-04&to=2026-11-06', 'from=2026-11-10', 'completion=all',
    'completion=both', 'reviewSelection=all', 'reviewSelection=review94', 'reviewSelection=unknown',
    'dateBasis=started', 'agreement=both', 'page=2', 'meetingPeriod=meeting-volume-20261125',
  ]) {
    const original = new URLSearchParams(query);
    const next = summarySelectionParams(original, selection, period);
    assert.equal(next.toString(), original.toString(), query);
    const returnTo = `/?${original}`;
    const detail = new URL(conversationLink('example', returnTo), 'https://pulso.invalid');
    assert.equal(conversationReturn(detail.searchParams).to, returnTo);
  }
});
