import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogReferences, digest, evaluationContext } from '../src/evaluation-context.js';
import { dailyAssignedCountries, dailyAssignedCounts, hasNewDailyQuotaEntries, withinDailyLimit } from '../src/daily-activity.js';

const day = { date: '2026-11-12', timezone: 'America/Tegucigalpa' };
const chat = (id, country = 'HN') => ({ id: String(id), country, completed: true,
  lastActivityAt: '2026-11-12T18:00:00.000Z', messages: [{ id: `message-${id}`, actor: 'cliente', text: 'Hola', timestamp: '2026-11-12T18:00:00.000Z' }] });
function fixture() {
  const profiles = ['clef-local', 'gemma-local'].map(id => ({ id, provider: 'gateway', model: id, configurationHash: digest(id), protocol: 'chat' }));
  const handoff = { id: 'thursday-test', runDate: '2026-11-13', activityDate: day.date, timezone: day.timezone,
    scopeHash: 'test-scope', countries: ['HN', 'PA'], profiles, limitPerCountry: 200 };
  const state = { settings: { thursdayHandoff: handoff }, catalog: [{ id: 'flag', version: 1, active: true, type: 'Flag', method: 'IA' }],
    jobs: [], tasks: [], evaluations: [], conversations: [], operationalRefs: [] };
  const options = { scheduleDate: handoff.runDate, limitPerCountry: 200, modelIds: profiles.map(p => p.id),
    dailyActivity: { ...day, handoffId: handoff.id, handoffScopeHash: handoff.scopeHash } };
  return { state, options, profiles };
}
function frozenJob(state, quota, { id = 'first', createdAt = '2026-11-13T08:00:00Z', conversationIds = [], conversationCountries = {} } = {}) {
  state.jobs.push({ id, createdAt, dailyActivity: { ...day }, conversationIds, conversationCountries,
    dailyQuotaCountries: Object.fromEntries(quota) });
}
function reusable(state, profiles, id, country = 'HN') {
  const c = chat(id, country), context = evaluationContext(c, state.catalog), jobId = `previous-${id}`;
  state.conversations.push(c);
  state.jobs.push({ id: jobId, purpose: 'operational', mode: 'dual', modelProfiles: structuredClone(profiles), conversationIds: [c.id] });
  profiles.forEach((profile, i) => {
    const task = { id: `task-${id}-${i}`, jobId, conversationId: c.id, status: 'completed', profile: structuredClone(profile),
      context: { ...context }, evaluationId: `evaluation-${id}-${i}` };
    state.tasks.push(task);
    state.evaluations.push({ id: task.evaluationId, jobId, taskId: task.id, conversationId: c.id, purpose: 'operational',
      profileId: profile.id, requestedProfileId: profile.id, provider: profile.provider, model: profile.model,
      modelConfiguration: structuredClone(profile), ...context, partial: false, validationErrors: [], usedFallback: false,
      catalogVersions: catalogReferences(state.catalog), results: [{ variableId: 'flag', status: 'evaluado', value: 0, evidence: [] }] });
  });
  state.operationalRefs.push({ id: c.id, evaluationId: `evaluation-${id}-0` });
  return c;
}

test('a reused pair consumes one country slot and leaves only 199 new HN conversations', () => {
  const { state, options, profiles } = fixture();
  reusable(state, profiles, 'reused');
  const candidates = Array.from({ length: 201 }, (_, i) => chat(i + 1));
  state.conversations.push(...candidates);
  assert.deepEqual(dailyAssignedCounts(state, options), { HN: 1 });
  const selected = withinDailyLimit(state, candidates, options);
  assert.equal(selected.length, 199);
  assert.deepEqual(selected.map(c => c.id), Array.from({ length: 199 }, (_, i) => String(i + 1)));
});

test('frozen reused entries keep their original country and occupied slot after source deletion or country change', () => {
  const { state, options } = fixture();
  const quota = new Map(Array.from({ length: 200 }, (_, i) => [String(i + 1), 'HN']));
  frozenJob(state, quota);
  state.conversations = [chat('1', 'PA')];
  frozenJob(state, new Map([['1', 'PA']]), { id: 'later', createdAt: '2026-11-13T09:00:00Z', conversationIds: ['1'], conversationCountries: { 1: 'PA' } });
  assert.equal(dailyAssignedCountries(state, options).get('1'), 'HN');
  assert.deepEqual(dailyAssignedCounts(state, options), { HN: 200 });
  assert.deepEqual(withinDailyLimit(state, [chat('201'), chat('pa-new', 'PA')], options).map(c => c.id), ['pa-new']);
  state.conversations = [];
  assert.deepEqual(dailyAssignedCounts(state, options), { HN: 200 });
});

test('the same ID can receive changed-source review at a full cap without admitting a 201st ID', () => {
  const { state, options } = fixture();
  frozenJob(state, new Map(Array.from({ length: 200 }, (_, i) => [String(i + 1), 'HN'])));
  const changed = chat('1'); changed.messages[0].text = 'Contenido nuevo';
  const selected = withinDailyLimit(state, [chat('201'), changed, chat('pa-new', 'PA')], options);
  assert.deepEqual(selected.map(c => c.id), ['1', 'pa-new']);
});

test('quota accumulates unique IDs across batches and separates HN from PA', () => {
  const { state, options } = fixture();
  const first = new Map(Array.from({ length: 100 }, (_, i) => [`hn-${i}`, 'HN']));
  frozenJob(state, first);
  const second = new Map([...first, ...Array.from({ length: 100 }, (_, i) => [`hn-${i + 100}`, 'HN']), ['pa-one', 'PA']]);
  frozenJob(state, second, { id: 'second', createdAt: '2026-11-13T10:00:00Z' });
  assert.deepEqual(dailyAssignedCounts(state, options), { HN: 200, PA: 1 });
  const candidates = [chat('hn-overflow'), ...Array.from({ length: 200 }, (_, i) => chat(`pa-${i + 1}`, 'PA'))];
  const selected = withinDailyLimit(state, candidates, options);
  assert.equal(selected.length, 199); assert.ok(selected.every(c => c.country === 'PA'));
});

test('200 reused pairs fill quota, advertise a durable empty-job update and exclude late equivalent 201', () => {
  const { state, options, profiles } = fixture();
  for (let i = 1; i <= 200; i++) reusable(state, profiles, String(i));
  assert.equal(hasNewDailyQuotaEntries(state, options), true);
  const quota = dailyAssignedCountries(state, options);
  assert.equal(quota.size, 200);
  frozenJob(state, quota);
  assert.equal(hasNewDailyQuotaEntries(state, options), false);
  reusable(state, profiles, '201');
  assert.equal(dailyAssignedCountries(state, options).size, 200);
  assert.equal(dailyAssignedCountries(state, options).has('201'), false);
  assert.equal(hasNewDailyQuotaEntries(state, options), false);
  assert.deepEqual(withinDailyLimit(state, [chat('202')], options), []);
});

test('late equivalents consume only available slots and must be frozen even with no new tasks', () => {
  const { state, options, profiles } = fixture();
  frozenJob(state, new Map(Array.from({ length: 199 }, (_, i) => [`frozen-${i}`, 'HN'])));
  reusable(state, profiles, '1001'); reusable(state, profiles, '1002');
  assert.equal(hasNewDailyQuotaEntries(state, options), true);
  const quota = dailyAssignedCountries(state, options);
  assert.equal(quota.size, 200); assert.equal(quota.has('1001'), true); assert.equal(quota.has('1002'), false);
  frozenJob(state, quota, { id: 'empty-late-reuse', createdAt: '2026-11-13T11:00:00Z' });
  assert.equal(hasNewDailyQuotaEntries(state, options), false);
  state.conversations = state.conversations.filter(c => c.id !== '1001');
  assert.equal(dailyAssignedCountries(state, options).size, 200);
  assert.equal(dailyAssignedCountries(state, options).has('1002'), false);
});

test('quota preview and candidate selection are stable under source import order and do not mutate state', () => {
  const { state, options } = fixture();
  const candidates = [chat('100'), chat('2'), chat('10'), chat('1')];
  state.conversations = candidates; const before = structuredClone(state);
  assert.deepEqual(withinDailyLimit(state, candidates, options).map(c => c.id), ['1', '2', '10', '100']);
  assert.deepEqual(withinDailyLimit(state, [...candidates].reverse(), options).map(c => c.id), ['1', '2', '10', '100']);
  assert.deepEqual(state, before);
});
