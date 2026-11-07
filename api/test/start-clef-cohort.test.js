import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, readlink, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preservationBaseline, originalsPreserved, cohortStatus, workerRunManifest, refreshWorkerSnapshot } from '../scripts/start-clef-cohort.js';

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

test('resuming preserves the first start, original cohort contract and previous failure audit', () => {
  const { manifest } = fixture();
  Object.assign(manifest, { status: 'blocked', pid: 123, startedAt: '2026-11-07T18:00:00.000Z',
    finishedAt: '2026-11-07T19:00:00.000Z', errorCode: 'MODEL_REQUIRES_INTERVENTION',
    conversationIds: Array.from({ length: 500 }, (_, i) => String(i)),
    gemmaProfile: { id: 'gemma-local', configurationHash: 'original-gemma-hash' },
    policyHash: 'original-policy-hash', catalogHash: 'original-catalog-hash',
    originalIntegrityHash: 'original-manifest-hash' });
  const before = structuredClone(manifest);
  const next = workerRunManifest(manifest, { resume: true, pid: 456, now: '2026-11-07T21:00:00.000Z' });
  assert.deepEqual(manifest, before);
  assert.equal(next.startedAt, before.startedAt);
  assert.equal(next.lastStartedAt, '2026-11-07T21:00:00.000Z');
  assert.equal(next.status, 'running');
  assert.equal(next.pid, 456);
  assert.equal('errorCode' in next, false);
  assert.equal('finishedAt' in next, false);
  assert.deepEqual(next.workerRuns, [{ pid: 456, startedAt: '2026-11-07T21:00:00.000Z', resume: true,
    previousStatus: 'blocked', previousErrorCode: 'MODEL_REQUIRES_INTERVENTION', previousFinishedAt: before.finishedAt }]);
  for (const field of ['baseline', 'conversationIds', 'profile', 'gemmaProfile', 'policyHash', 'catalogHash', 'originalIntegrityHash']) {
    assert.deepEqual(next[field], before[field], `${field} remains unchanged`);
  }
});

test('first launch initializes time once and later resumes append their own timestamps', () => {
  const { manifest } = fixture();
  const first = workerRunManifest(manifest, { pid: 1, now: '2026-11-07T18:00:00Z' });
  assert.equal(first.startedAt, '2026-11-07T18:00:00Z');
  first.status = 'partial';
  const second = workerRunManifest(first, { resume: true, pid: 2, now: '2026-11-07T20:00:00Z' });
  assert.equal(second.startedAt, first.startedAt);
  assert.equal(second.workerRuns.length, 2);
  assert.deepEqual(second.workerRuns[0], first.workerRuns[0]);
  assert.throws(() => workerRunManifest({ ...first, status: 'completed' }, { resume: true }), { cohortCode: 'WORKER_ALREADY_STARTED' });
});

async function snapshotFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pulso-worker-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceApi = path.join(root, 'reviewed-api'), cohortDirectory = path.join(root, 'cohort');
  const workerApi = path.join(cohortDirectory, 'worker-api'), dependenciesPath = path.join(root, 'dependencies');
  for (const api of [sourceApi, workerApi]) {
    await mkdir(path.join(api, 'scripts'), { recursive: true });
    await mkdir(path.join(api, 'src'), { recursive: true });
    await writeFile(path.join(api, 'package.json'), '{}');
    await writeFile(path.join(api, 'scripts/start-clef-cohort.js'), api === sourceApi ? 'reviewed worker' : 'previous worker');
    await writeFile(path.join(api, 'src/evaluation-service.js'), api === sourceApi ? 'reviewed evaluator' : 'previous evaluator');
  }
  await mkdir(dependenciesPath);
  await mkdir(path.join(sourceApi, '.data'));
  await writeFile(path.join(sourceApi, '.env'), privateText);
  await writeFile(path.join(sourceApi, '.env.production'), privateText);
  await writeFile(path.join(sourceApi, '.data/results.json'), privateText);
  await writeFile(path.join(sourceApi, 'scripts/private.log'), privateText);
  await writeFile(path.join(cohortDirectory, 'manifest.json'), 'original-manifest');
  await writeFile(path.join(cohortDirectory, 'worker.log'), 'original-log');
  await writeFile(path.join(cohortDirectory, 'results.json'), 'original-results');
  return { sourceApi, cohortDirectory, workerApi, dependenciesPath };
}

test('reviewed code replaces the stopped worker, retaining its backup and all runtime output', async t => {
  const fixture = await snapshotFixture(t);
  let guards = 0;
  const update = await refreshWorkerSnapshot({ ...fixture, verifyStopped: async () => { guards++; } });
  assert.equal(guards, 2);
  assert.equal(update.status, 'installed');
  assert.match(update.codeHash, /^[a-f0-9]{64}$/);
  assert.notEqual(update.codeHash, update.previousCodeHash);
  assert.equal(await readFile(path.join(fixture.workerApi, 'scripts/start-clef-cohort.js'), 'utf8'), 'reviewed worker');
  assert.equal(await readFile(path.join(fixture.cohortDirectory, update.backupDirectory, 'scripts/start-clef-cohort.js'), 'utf8'), 'previous worker');
  assert.equal(await readlink(path.join(fixture.workerApi, 'node_modules')), fixture.dependenciesPath);
  for (const [file, content] of [['manifest.json', 'original-manifest'], ['worker.log', 'original-log'], ['results.json', 'original-results']]) {
    assert.equal(await readFile(path.join(fixture.cohortDirectory, file), 'utf8'), content);
  }
  for (const omitted of ['.env', '.env.production', '.data', 'scripts/private.log']) {
    await assert.rejects(readFile(path.join(fixture.workerApi, omitted)), { code: 'ENOENT' });
  }
  const journal = JSON.parse(await readFile(path.join(fixture.cohortDirectory, update.journalFile), 'utf8'));
  assert.equal(journal.codeHash, update.codeHash);
  assert.equal(journal.status, 'installed');
  assert.doesNotMatch(JSON.stringify(journal), new RegExp(privateText));
});

test('failed install restores the old worker and keeps the staged code and rollback journal', async t => {
  const fixture = await snapshotFixture(t);
  let renames = 0;
  await assert.rejects(refreshWorkerSnapshot({ ...fixture, verifyStopped: async () => {}, renamePath: async (from, to) => {
    renames++;
    if (renames === 2) throw Object.assign(new Error('synthetic install failure'), { code: 'EIO' });
    return rename(from, to);
  } }), { code: 'EIO' });
  assert.equal(renames, 3);
  assert.equal(await readFile(path.join(fixture.workerApi, 'scripts/start-clef-cohort.js'), 'utf8'), 'previous worker');
  const files = await readdir(fixture.cohortDirectory);
  assert.ok(files.some(file => file.endsWith('.tmp')));
  const journal = JSON.parse(await readFile(path.join(fixture.cohortDirectory, files.find(file => file.startsWith('worker-update-'))), 'utf8'));
  assert.equal(journal.status, 'rolled-back');
  assert.equal(await readFile(path.join(fixture.cohortDirectory, 'worker.log'), 'utf8'), 'original-log');
});

test('a guard failure prevents swapping the worker and a changed code baseline is rejected', async t => {
  const fixture = await snapshotFixture(t);
  let checks = 0;
  await assert.rejects(refreshWorkerSnapshot({ ...fixture, verifyStopped: async () => {
    if (++checks === 2) throw Object.assign(new Error('worker restarted'), { cohortCode: 'WORKER_STILL_RUNNING' });
  } }), { cohortCode: 'WORKER_STILL_RUNNING' });
  assert.equal(await readFile(path.join(fixture.workerApi, 'scripts/start-clef-cohort.js'), 'utf8'), 'previous worker');
  await assert.rejects(refreshWorkerSnapshot({ ...fixture, expectedPreviousHash: 'wrong', verifyStopped: async () => {} }),
    { cohortCode: 'WORKER_CODE_CHANGED' });
  await assert.rejects(refreshWorkerSnapshot({ ...fixture, sourceApi: fixture.workerApi, verifyStopped: async () => {} }),
    { cohortCode: 'WORKER_SOURCE_NOT_REVIEWED' });
});

test('a context-limited case stays partial without stopping independent cases or retrying unchanged input', async () => {
  const { eligibleForCohortResume, requiresModelIntervention } = await import('../scripts/start-clef-cohort.js');
  const task = { profile: { id: 'clef-local' }, status: 'partial', round: 1, error: { code: 'AI_CONTEXT_LIMIT' } };
  assert.equal(requiresModelIntervention(task), false);
  assert.equal(eligibleForCohortResume(task), false);
  for (const code of ['AI_CONFIGURATION', 'MODEL_CHANGED', 'MODEL_IDENTITY_UNVERIFIED', 'UNSUPPORTED_VARIABLE']) {
    assert.equal(requiresModelIntervention({ ...task, error: { code } }), true);
  }
  assert.equal(eligibleForCohortResume({ ...task, error: { code: 'AI_SAFETY_REFUSAL' } }), false);
  assert.equal(eligibleForCohortResume({ ...task, error: { code: 'INVALID_AI_RESULT' } }), true);
  assert.equal(eligibleForCohortResume({ ...task, status: 'completed', error: null }), false);
});
