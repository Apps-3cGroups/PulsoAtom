import test from 'node:test';
import assert from 'node:assert/strict';
import { countMeetingCases, rankMeetingPeriods } from './audit-meeting-period.mjs';

const context = { sourceHash: 'source', catalogHash: 'catalog', promptHash: 'prompt', rulesVersion: 'rules' };
const refs = [{ id: 'flag', version: 1, active: true }];
function fixture() {
  const state = { jobs: [], tasks: [], evaluations: [], operationalRefs: [], comparisons: [],
    catalogVersions: [{ id: 'flag:1', itemId: 'flag', version: 1, snapshot: { method: 'IA', type: 'Flag' } }] };
  const add = (id, profiles = ['clef-local', 'gemma-local'], overrides = {}) => {
    const job = { id, purpose: 'operational', mode: profiles.length === 2 ? 'dual' : 'single', catalogVersions: refs,
      modelProfiles: profiles.map(profileId => ({ id: profileId, provider: 'gateway', model: profileId, configurationHash: profileId })) };
    state.jobs.push(job);
    for (const profile of job.modelProfiles) {
      const task = { id: `${id}:${profile.id}`, jobId: id, conversationId: 'c1', profile, context, status: 'completed', evaluationId: `e:${id}:${profile.id}` };
      const evaluation = { id: task.evaluationId, jobId: id, taskId: task.id, conversationId: 'c1', purpose: job.purpose,
        profileId: profile.id, requestedProfileId: profile.id, model: profile.model, provider: profile.provider,
        modelConfiguration: profile, catalogVersions: refs, ...context, partial: false, demo: false, usedFallback: false,
        results: [{ variableId: 'flag', status: 'evaluado', value: null }], ...overrides };
      state.tasks.push(task); state.evaluations.push(evaluation);
    }
    return job;
  };
  const metadata = [{ conversationId: 'c1', country: 'HN', activityAt: '2026-11-19T03:00:00Z' }];
  return { state, add, metadata };
}

test('counts one conversation per date and separates current reference from a complete retained job', () => {
  const f = fixture(); f.add('old'); f.add('new');
  f.state.tasks.find(task => task.id === 'new:gemma-local').status = 'running';
  f.state.operationalRefs.push({ id: 'c1', evaluationId: 'e:new:clef-local' });
  const result = countMeetingCases(f.state, f.metadata);
  assert.equal(result.visible[0].date, '2026-11-18');
  assert.equal(result.visible[0].bothComplete, 0);
  assert.equal(result.historical[0].bothComplete, 1);
  assert.equal(result.historical.length, 1);
  assert.equal(rankMeetingPeriods(result.historical).total.bothComplete, 1);
  assert.equal(f.state.evaluations.find(e => e.id === 'e:new:gemma-local').partial, false);
});

test('never combines independent single-model jobs into a complete pair', () => {
  const f = fixture(); f.add('left', ['clef-local']); f.add('right', ['gemma-local']);
  f.state.operationalRefs.push({ id: 'c1', evaluationId: 'e:right:gemma-local' });
  const result = countMeetingCases(f.state, f.metadata);
  assert.equal(result.historical[0].clefComplete, 1);
  assert.equal(result.historical[0].gemmaComplete, 1);
  assert.equal(result.historical[0].bothComplete, 0);
});

test('rejects partial, fallback, wrong context and unlinked retried results', () => {
  for (const mutate of [
    f => { f.state.evaluations[1].partial = true; },
    f => { f.state.evaluations[1].usedFallback = true; },
    f => { f.state.evaluations[1].sourceHash = 'different'; },
    f => { f.state.evaluations[1].validationErrorCount = 1; },
    f => { f.state.tasks[1].evaluationId = 'replacement'; },
    f => { f.state.evaluations[1].results[0].error = true; },
  ]) {
    const f = fixture(); f.add('job'); f.state.operationalRefs.push({ id: 'c1', evaluationId: 'e:job:clef-local' }); mutate(f);
    assert.equal(countMeetingCases(f.state, f.metadata).visible[0].bothComplete, 0);
  }
});

test('consecutive periods include zero-result days, and distinguish volume from six-country coverage', () => {
  const cases = [
    ...Array.from({ length: 20 }, () => ({ date: '2026-11-10', country: 'HN', anyComplete: 1, clefComplete: 1, gemmaComplete: 1, bothComplete: 1 })),
    ...['HN', 'PA', 'CR', 'SV', 'MX', 'NI'].map(country => ({ date: '2026-11-19', country, anyComplete: 1, clefComplete: 1, gemmaComplete: 1, bothComplete: 1 })),
  ];
  const result = rankMeetingPeriods(cases);
  assert.deepEqual(result.bestConsecutiveByBoth[0].dates, ['2026-11-08', '2026-11-09', '2026-11-10']);
  assert.equal(result.bestConsecutiveByBoth[0].bothComplete, 20);
  assert.equal(result.bestConsecutiveAllSixBoth[0].bothComplete, 6);
  assert.equal(result.bestConsecutiveAllSixBoth[0].countriesWithBoth, 6);
});
