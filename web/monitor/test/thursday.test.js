import test from 'node:test';
import assert from 'node:assert/strict';
import { createThursdayCollector } from '../thursday.js';
import { MonitorError } from '../progress.js';

const NOW = '2026-11-13T09:30:00.000Z';
const ids = ['clef-local', 'gemma-local'];
const profiles = ids.map((id, index) => ({ id, provider: 'gateway', model: ['clef-flash', 'gemma-4'][index], configurationHash: String(index + 1).repeat(64) }));
function fixture() {
  return { settings: { thursdayHandoff: { id: 'thursday-2026-11-12-after-recovery', activityDate: '2026-11-12',
    runDate: '2026-11-13', timezone: 'America/Tegucigalpa', countries: ['HN', 'PA'], modelIds: ids,
    profiles: structuredClone(profiles), scopeHash: 'a'.repeat(64), limitPerCountry: 200, concurrency: 1,
    status: 'running', preparedAt: '2026-11-13T04:00:00.000Z', updatedAt: NOW } }, jobs: [] };
}
function addJob(payload, id, members, { quota = members, statuses = {}, createdAt = NOW, updatedAt = createdAt, status = 'running' } = {}) {
  const h = payload.settings.thursdayHandoff;
  const job = { id, purpose: 'operational', scope: 'daily', mode: 'dual', dailyActivity: { date: h.activityDate,
    timezone: h.timezone, handoffId: h.id, handoffScopeHash: h.scopeHash }, limitPerCountry: 200, concurrency: 1,
    countries: ['HN', 'PA'], conversationCountries: { ...members }, dailyQuotaCountries: { ...quota },
    conversationIds: Object.keys(members), modelProfiles: structuredClone(profiles), caseCount: Object.keys(members).length,
    total: Object.keys(members).length * 2, status, createdAt, updatedAt,
    modelProgress: ids.map(profileId => ({ profileId, total: Object.keys(members).length, completed: 0, partial: 0, failed: 0, running: 0, pending: Object.keys(members).length })) };
  payload.jobs.push(job);
  const tasks = Object.keys(members).flatMap(conversationId => profiles.map((profile, index) => ({ id: `${id}:${conversationId}:${index}`,
    jobId: id, conversationId, profile: { ...profile }, status: statuses[conversationId]?.[index] || 'pending',
    context: { sourceHash: 'private-source-hash' }, error: { message: 'private-transcript' }, evaluationId: 'private-evaluation' })));
  return { job, tasks };
}
function reader(entries) {
  const calls = [], api = async (path, signal) => {
    calls.push({ path, signal });
    const response = entries.get(path);
    if (!response) throw new Error(`Unexpected path ${path}`);
    return response;
  };
  return { calls, collect: createThursdayCollector(api) };
}
const responses = (...entries) => new Map(entries.map(entry => [`/evaluations/${entry.job.id}/attempts`, { tasks: entry.tasks, attempts: [{ prompt: 'private-prompt' }] }]));

test('counts exact complete pairs by country, partials and registered prior pairs separately', async () => {
  const payload = fixture();
  const entry = addJob(payload, 'one', { a: 'PA', b: 'HN', c: 'PA', d: 'HN' }, {
    quota: { a: 'PA', b: 'HN', c: 'PA', d: 'HN', previousHN: 'HN', previousPA: 'PA' },
    statuses: { a: ['completed', 'completed'], b: ['completed', 'partial'], c: ['running', 'pending'], d: ['failed', 'completed'] },
  });
  const { collect } = reader(responses(entry)), data = await collect(payload, undefined, NOW);
  assert.deepEqual([data.registered, data.assigned, data.reused, data.completed, data.remaining, data.runningConversations], [6, 4, 2, 3, 3, 1]);
  assert.deepEqual(data.countries.map(row => [row.country, row.registered, row.assigned, row.reused, row.completed, row.remaining, row.running]),
    [['HN', 3, 2, 1, 1, 2, 0], ['PA', 3, 2, 1, 2, 1, 1]]);
  assert.deepEqual(data.counts, { total: 8, completed: 4, partial: 1, failed: 1, running: 1, pending: 1 });
  assert.equal(data.active, true); assert.equal(data.models[0].active, true); assert.equal(data.models[1].active, false);
  assert.equal(data.models[0].percent, 50);
  assert.match(data.warnings.join(' '), /Automations/); assert.match(data.warnings.join(' '), /al incorporar/);
});

test('latest created job wins source-version overlaps and ledger never inflates repeated IDs', async () => {
  const payload = fixture();
  const older = addJob(payload, 'older', { a: 'HN', b: 'PA' }, { quota: { a: 'HN', b: 'PA', prior: 'HN' },
    createdAt: '2026-11-13T08:00:00.000Z', updatedAt: NOW, statuses: { a: ['completed', 'completed'], b: ['completed', 'completed'] } });
  const newer = addJob(payload, 'newer', { a: 'HN', c: 'PA' }, { quota: { a: 'HN', b: 'PA', c: 'PA', prior: 'HN' },
    createdAt: '2026-11-13T09:00:00.000Z', statuses: { a: ['completed', 'pending'], c: ['completed', 'completed'] } });
  payload.jobs.reverse();
  const { collect } = reader(responses(older, newer)), data = await collect(payload, undefined, NOW);
  assert.deepEqual([data.registered, data.assigned, data.reused, data.completed, data.remaining], [4, 3, 1, 3, 1]);
  assert.deepEqual(data.counts, { total: 6, completed: 5, partial: 0, failed: 0, running: 0, pending: 1 });
  assert.deepEqual(data.batches.map(batch => [batch.id, batch.cases, batch.originalCases, batch.supersededCases]), [['older', 1, 2, 1], ['newer', 2, 2, 0]]);
});

test('reads only changed jobs and prunes removed job cache; accepts newer task counts than list snapshot', async () => {
  const payload = fixture(), a = addJob(payload, 'a', { a: 'HN' }), b = addJob(payload, 'b', { b: 'PA' });
  const source = responses(a, b), { collect, calls } = reader(source), signal = new AbortController().signal;
  await collect(payload, signal, NOW); await collect(payload, signal, NOW);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.signal === signal));
  a.tasks.forEach(task => { task.status = 'completed'; }); a.job.updatedAt = '2026-11-13T09:30:01.000Z';
  let data = await collect(payload, signal, NOW);
  assert.equal(calls.length, 3); assert.equal(data.counts.completed, 2); // modelProgress is still pending.
  b.job.modelProgress[0].running = 1; b.job.modelProgress[0].pending = 0;
  await collect(payload, signal, NOW); assert.equal(calls.length, 4);
  b.job.status = 'interrupted'; await collect(payload, signal, NOW); assert.equal(calls.length, 5);
  payload.jobs = [a.job]; await collect(payload, signal, NOW);
  payload.jobs.push(b.job); await collect(payload, signal, NOW); assert.equal(calls.length, 6);
});

test('does not read or expose attempts, source diagnostics or conversation IDs', async () => {
  const payload = fixture(), entry = addJob(payload, 'job', { 'private-conversation-id': 'HN' });
  const response = { tasks: entry.tasks };
  Object.defineProperty(response, 'attempts', { get() { throw new Error('Attempts must not be read'); } });
  const { collect } = reader(new Map([['/evaluations/job/attempts', response]]));
  const serialized = JSON.stringify(await collect(payload, undefined, NOW));
  assert.doesNotMatch(serialized, /private-|sourceHash|evaluationId|conversationId|attempts|context/);
  entry.tasks.forEach(task => { task.status = 'completed'; });
  const cached = await collect(payload, undefined, NOW);
  assert.equal(cached.counts.completed, 0); // Cached values do not retain API object references.
});

test('interrupted tasks remain pending with a warning; stale jobs never claim active evaluation', async () => {
  const payload = fixture(), entry = addJob(payload, 'job', { a: 'HN', b: 'PA' }, {
    updatedAt: '2026-11-13T09:00:00.000Z', statuses: { a: ['interrupted', 'completed'], b: ['running', 'pending'] },
  });
  const { collect } = reader(responses(entry)), data = await collect(payload, undefined, NOW);
  assert.equal(data.counts.pending, 2); assert.equal(data.remaining, 2);
  assert.match(data.warnings.join(' '), /interrumpidas/); assert.equal(data.active, false); assert.equal(data.stalled, true);
});

test('no jobs means unconfirmed coverage, not a completed Thursday', async () => {
  const payload = fixture(), { collect, calls } = reader(new Map());
  payload.settings.thursdayHandoff.status = 'completed';
  let data = await collect(payload, undefined, NOW);
  assert.equal(data.status, 'prepared'); assert.equal(data.registered, 0); assert.equal(data.models[0].percent, 0);
  assert.match(data.warnings.join(' '), /pendiente de confirmación/); assert.equal(calls.length, 0);
  delete payload.settings.thursdayHandoff; data = await collect(payload, undefined, NOW);
  assert.equal(data.enabled, false); assert.equal(calls.length, 0);
});

test('validates handoff scope, profiles, task pairs, country mappings and 200 unique quota per country', async () => {
  const mutations = [
    p => { p.settings.thursdayHandoff.id = 'another-handoff'; },
    p => { p.settings.thursdayHandoff.scopeHash = 'invalid'; },
    p => { p.settings.thursdayHandoff.countries = ['HN', 'HN']; },
    p => { p.settings.thursdayHandoff.profiles[0].model = 'changed'; },
    p => { p.jobs[0].dailyActivity.handoffScopeHash = 'b'.repeat(64); },
    p => { p.jobs[0].conversationCountries.a = 'MX'; },
    p => { delete p.jobs[0].dailyQuotaCountries.a; },
    p => { p.jobs[0].dailyQuotaCountries = Object.fromEntries(['a', ...Array.from({ length: 200 }, (_, i) => `extra${i}`)].map(id => [id, 'HN'])); },
    p => { p.jobs.push(structuredClone(p.jobs[0])); },
    (p, entry) => { entry.tasks[1] = { ...entry.tasks[0], id: 'duplicate-pair' }; },
    (p, entry) => { entry.tasks[0].profile.model = 'wrong-model'; },
    (p, entry) => { entry.tasks[0].status = 'unknown'; },
    (p, entry) => { entry.tasks.pop(); },
    (p, entry) => { entry.tasks[0] = null; },
  ];
  for (const mutate of mutations) {
    const payload = fixture(), entry = addJob(payload, 'job', { a: 'HN' }); mutate(payload, entry);
    const { collect } = reader(responses(entry));
    await assert.rejects(collect(payload, undefined, NOW), MonitorError);
  }
});

test('accepts a full quota with repeated ledger entries across jobs and ignores unrelated jobs', async () => {
  const payload = fixture(), quota = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`h${i}`, 'HN']));
  const a = addJob(payload, 'a', { h0: 'HN' }, { quota, statuses: { h0: ['completed', 'completed'] } });
  const b = addJob(payload, 'b', { h1: 'HN' }, { quota, statuses: { h1: ['completed', 'completed'] } });
  payload.jobs.push({ id: 'unrelated', dailyActivity: { handoffId: 'other' } });
  const { collect } = reader(responses(a, b)), data = await collect(payload, undefined, NOW);
  assert.equal(data.registered, 200); assert.equal(data.assigned, 2); assert.equal(data.reused, 198);
  assert.equal(data.completed, 200); assert.equal(data.counts.total, 4); assert.equal(data.status, 'running');
});

test('empty jobs freeze reused quota without fetching tasks; later jobs add new pairs normally', async () => {
  const payload = fixture(), quota = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`prior${i}`, i < 20 ? 'HN' : 'PA']));
  addJob(payload, 'empty', {}, { quota, status: 'completed', createdAt: '2026-11-13T08:00:00.000Z' });
  const source = new Map(), { collect, calls } = reader(source);
  let data = await collect(payload, undefined, NOW);
  assert.deepEqual([data.registered, data.assigned, data.reused, data.completed, data.remaining, data.counts.total], [41, 0, 41, 41, 0, 0]);
  assert.equal(calls.length, 0); assert.equal(data.batches[0].cases, 0);
  const next = addJob(payload, 'next', { nextHN: 'HN', nextPA: 'PA' }, { quota: { ...quota, nextHN: 'HN', nextPA: 'PA' },
    statuses: { nextHN: ['completed', 'completed'] } });
  source.set('/evaluations/next/attempts', { tasks: next.tasks });
  data = await collect(payload, undefined, NOW);
  assert.deepEqual([data.registered, data.assigned, data.reused, data.completed, data.remaining], [43, 2, 41, 42, 1]);
  assert.equal(calls.length, 1);
});

test('a source country correction does not alter the original quota country grouping', async () => {
  const payload = fixture(), entry = addJob(payload, 'job', { corrected: 'PA' }, { quota: { corrected: 'HN' },
    statuses: { corrected: ['completed', 'completed'] } });
  const { collect } = reader(responses(entry)), data = await collect(payload, undefined, NOW);
  assert.deepEqual(data.countries.map(row => [row.country, row.registered, row.completed]), [['HN', 1, 1], ['PA', 0, 0]]);
});
