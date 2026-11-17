import test from 'node:test';
import assert from 'node:assert/strict';
import { activeFigureKinds, activeRequestPath, visibleActiveMarks } from '../src/services/activeBoard.js';
import { selectedFigures } from '../src/services/summaryFilters.js';

test('active requests preserve no exceptions separately from all exceptions before server pagination', () => {
  const selected = value => selectedFigures(new URLSearchParams(value), activeFigureKinds);
  assert.deepEqual(selected(''), ['critical', 'normal', 'positive']);
  assert.deepEqual(selected('figures=human,refuted,critical,critical'), ['critical']);
  const all = new URLSearchParams(activeRequestPath({ countries: ['HN', 'PA'], page: 2, figures: selected('') }).split('?')[1]);
  assert.equal(all.has('figures'), false);
  assert.equal(all.get('page'), '2');
  assert.equal(all.get('pageSize'), '12');
  assert.equal(all.get('countries'), 'HN,PA');
  const none = new URLSearchParams(activeRequestPath({ countries: [], page: 1, figures: selected('figures=') }).split('?')[1]);
  assert.equal(none.has('figures'), true);
  assert.equal(none.get('figures'), '');
  const some = new URLSearchParams(activeRequestPath({ countries: ['PA'], page: 1, figures: selected('figures=positive,normal') }).split('?')[1]);
  assert.equal(some.get('figures'), 'positive,normal');
});

test('active cards retain human flags by effective classification and exclude refutations and unselected categories', () => {
  const marks = [
    { id: 'positive', kind: 'positive', classification: 'positive', effective: true },
    { id: 'human', kind: 'human', classification: 'critical', effective: true, origin: 'human' },
    { id: 'normal', kind: 'normal', classification: 'normal', effective: true },
    { id: 'refuted', kind: 'refuted', classification: 'critical', effective: false },
    { id: 'inactive', kind: 'positive', classification: 'positive', effective: false },
    { id: 'media', kind: 'media' },
    { id: 'coaching', kind: 'coaching', effective: true },
  ];
  const before = structuredClone(marks);
  assert.deepEqual(visibleActiveMarks({ marks }).map(m => m.id), ['human', 'normal', 'positive']);
  assert.deepEqual(visibleActiveMarks({ marks }, ['critical', 'positive']).map(m => m.id), ['human', 'positive']);
  assert.deepEqual(visibleActiveMarks({ marks }, []), []);
  assert.deepEqual(marks, before);
});
