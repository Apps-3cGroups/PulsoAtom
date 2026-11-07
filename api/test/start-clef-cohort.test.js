import test from 'node:test';
import assert from 'node:assert/strict';
import { preservationBaseline, originalsPreserved, cohortStatus } from '../scripts/start-clef-cohort.js';

const maintenanceId = '77f134e8-fdf8-4154-b1f6-485c159b9194';
const cohortId = `clef-complement-${maintenanceId}`;
const privateText = 'SYNTHETIC-PRIVATE-REASON-NEVER-LOG';
const protectedFields = ['evaluations', 'tasks', 'attempts', 'operationalRefs', 'reviews', 'verdicts'];

function fixture() {
  const state = {
    evaluations: [{ id: 'gemma-evaluation', profileId: 'gemma-local', results: [
      { variableId: 'example', value: 1, reason: privateText, evidence: [{ messageId: 'private-message', quote: privateText }] },
    ] }],
    tasks: [{ id: 'gemma-task', jobId: 'gemma-job', profile: { id: 'gemma-local' }, status: 'partial', evaluationId: 'gemma-evaluation' }],
    attempts: [{ id: 'gemma-attempt', taskId: 'gemma-task', status: 'completed' }],
    operationalRefs: [{ id: 'private-conversation', evaluationId: 'gemma-evaluation' }],
    reviews: [{ id: 'review', reason: privateText }],
    verdicts: [{ id: 'verdict', value: 'absent', reason: privateText }],
    jobs: [{ id: 'gemma-job', purpose: 'operational', status: 'partial' }],
    comparisons: [], settings: { dailyEnabled: false },
  };
  const manifest = { status: 'prepared', profile: { id: 'clef-local', model: 'clef-flash' },
    updatedAt: '2026-11-07T20:00:00.000Z', baseline: preservationBaseline(state) };
  return { state, manifest };
}

test('preservation baseline retains hashes only and does not mutate or copy private content', () => {
  const { state } = fixture(), before = structuredClone(state);
  const baseline = preservationBaseline(state);
  assert.deepEqual(state, before);
  assert.equal(originalsPreserved(state, baseline), true);
  for (const field of protectedFields) {
    assert.equal(baseline[field].length, 1);
    assert.deepEqual(Object.keys(baseline[field][0]).sort(), ['hash', 'id']);
    assert.match(baseline[field][0].hash, /^[a-f0-9]{64}$/);
  }
  assert.doesNotMatch(JSON.stringify(baseline), new RegExp(privateText));
});

test('new Clef records may be appended while every original remains unchanged', () => {
  const { state, manifest } = fixture();
  for (const field of protectedFields) state[field].push({ id: `new-clef-${field}`, value: 'synthetic' });
  assert.equal(originalsPreserved(state, manifest.baseline), true);
  assert.equal(manifest.baseline.evaluations.length, 1, 'The baseline is not a live reference to appended records');
});

test('changing or removing any protected original fails preservation', () => {
  for (const field of protectedFields) {
    const { state, manifest } = fixture();
    state[field][0].tampered = true;
    assert.equal(originalsPreserved(state, manifest.baseline), false, `${field} change must be detected`);
    delete state[field][0].tampered;
    assert.equal(originalsPreserved(state, manifest.baseline), true);
    state[field] = [];
    assert.equal(originalsPreserved(state, manifest.baseline), false, `${field} deletion must be detected`);
  }
});

test('MySQL object key reordering is harmless but result array order is preserved', () => {
  const { state, manifest } = fixture();
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  assert.equal(originalsPreserved(reorder(state), manifest.baseline), true);
  state.evaluations[0].results.push({ variableId: 'second', value: 0 });
  const baseline = preservationBaseline(state);
  state.evaluations[0].results.reverse();
  assert.equal(originalsPreserved(state, baseline), false);
});

test('status counts only Clef tasks from this cohort, including unstarted cases in pending', () => {
  const { state, manifest } = fixture();
  manifest.status = 'running';
  const statuses = [...Array(10).fill('completed'), ...Array(3).fill('partial'),
    ...Array(2).fill('failed'), 'running', ...Array(4).fill('pending')];
  state.jobs.push({ id: 'clef-job', cohortId, status: 'running' }, { id: 'unrelated-job', cohortId: 'other', status: 'completed' });
  state.tasks.push(...statuses.map((status, i) => ({ id: `clef-${i}`, jobId: 'clef-job',
    profile: { id: 'clef-local' }, status })),
  { id: 'reused-gemma', jobId: 'clef-job', profile: { id: 'gemma-local' }, status: 'partial' },
  { id: 'unrelated-clef', jobId: 'unrelated-job', profile: { id: 'clef-local' }, status: 'completed' });
  const status = cohortStatus(state, manifest);
  assert.deepEqual({ total: status.total, completed: status.completed, partial: status.partial,
    failed: status.failed, running: status.running, pending: status.pending },
  { total: 500, completed: 10, partial: 3, failed: 2, running: 1, pending: 484 });
  assert.equal(status.batchesCreated, 1);
  assert.deepEqual(status.comparisonIds, ['clef-job']);
  assert.equal(status.workerAlive, false);
  assert.equal(status.originalRecordsPreserved, true);
  assert.equal(status.dailyPaused, true);
  assert.doesNotMatch(JSON.stringify(status), /SYNTHETIC-PRIVATE|private-conversation|private-message/);
});

test('status surfaces blocked worker, resumed daily schedule and changed originals independently', () => {
  const { state, manifest } = fixture();
  manifest.status = 'blocked'; manifest.errorCode = 'SOURCE_CHANGED';
  state.settings.dailyEnabled = true;
  state.evaluations[0].results[0].value = 0;
  const status = cohortStatus(state, manifest);
  assert.equal(status.status, 'blocked');
  assert.equal(status.errorCode, 'SOURCE_CHANGED');
  assert.equal(status.dailyPaused, false);
  assert.equal(status.originalRecordsPreserved, false);
  assert.equal(status.pending, 500);
});

test('status reports only allowlisted aggregate error codes without provider text', () => {
  const { state, manifest } = fixture();
  state.jobs.push({ id: 'clef-job', cohortId });
  state.tasks.push(...['AI_SAFETY_REFUSAL', 'AI_SAFETY_REFUSAL', privateText].map((code, i) => ({
    id: `clef-${i}`, jobId: 'clef-job', profile: { id: 'clef-local' }, status: 'partial',
    error: { code, message: privateText, details: privateText },
  })));
  const status = cohortStatus(state, manifest);
  assert.deepEqual(status.taskErrorCounts, { AI_SAFETY_REFUSAL: 2, OTHER_ERROR: 1 });
  assert.doesNotMatch(JSON.stringify(status), new RegExp(privateText));
});
