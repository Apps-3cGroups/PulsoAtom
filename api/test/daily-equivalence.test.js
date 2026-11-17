import test from 'node:test';
import assert from 'node:assert/strict';
import { completedOperationalPair, assignedHandoffVersion } from '../src/daily-equivalence.js';
import { catalogReferences, digest, evaluationContext } from '../src/evaluation-context.js';

function fixture() {
  const conversation = { id: 'same-chat', country: 'HN', completed: true,
    messages: [{ id: 'message-1', actor: 'cliente', text: 'Texto original sin modificar', timestamp: '2026-11-12T18:00:00.000Z' }] };
  const catalog = [
    { id: 'flag-a', version: 3, active: true, type: 'Flag', method: 'IA' },
    { id: 'flag-b', version: 2, active: true, type: 'Flag', method: 'IA' },
    { id: 'inactive', version: 1, active: false, type: 'Flag', method: 'IA' },
    { id: 'retired', version: 1, active: true, retired: true, type: 'Flag', method: 'IA' },
  ];
  const profiles = ['clef-local', 'gemma-local'].map(id => ({ id, provider: 'gateway', model: `${id}-model`, configurationHash: digest({ id }), protocol: 'chat' }));
  const context = evaluationContext(conversation, catalog);
  const job = { id: 'dual-job', purpose: 'operational', mode: 'dual', status: 'completed', conversationIds: [conversation.id],
    modelProfiles: structuredClone(profiles), catalogVersions: catalogReferences(catalog) };
  const tasks = profiles.map((profile, i) => ({ id: `task-${i}`, jobId: job.id, conversationId: conversation.id,
    profile: structuredClone(profile), context: { ...context }, status: 'completed', error: null, evaluationId: `evaluation-${i}` }));
  const evaluations = tasks.map((task, i) => ({ id: task.evaluationId, taskId: task.id, jobId: job.id,
    conversationId: conversation.id, purpose: 'operational', ...context, partial: false, validationErrors: [],
    profileId: profiles[i].id, requestedProfileId: profiles[i].id, provider: profiles[i].provider,
    model: profiles[i].model, modelConfiguration: structuredClone(profiles[i]), usedFallback: false,
    catalogVersions: catalogReferences(catalog), results: [
      { variableId: 'flag-a', status: 'evaluado', value: 0, evidence: [] },
      { variableId: 'flag-b', status: 'no_evaluado', value: null, evidence: [], reason: 'Sin contexto suficiente' },
    ] }));
  const state = { catalog, conversations: [conversation], jobs: [job], tasks, evaluations,
    operationalRefs: [{ id: conversation.id, evaluationId: evaluations[0].id }] };
  return { state, conversation, profiles };
}
const sortObjectKeys = value => Array.isArray(value) ? value.map(sortObjectKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortObjectKeys(value[key])])) : value;

test('reuses a complete current operational pair, including valid abstention, without mutating any source or result', () => {
  const { state, conversation, profiles } = fixture(), before = structuredClone(state);
  assert.equal(completedOperationalPair(state, conversation, profiles), true);
  assert.deepEqual(state, before);
});

test('MySQL JSON key ordering does not prevent equivalence or rewrite historical hashes', () => {
  const original = fixture();
  const state = sortObjectKeys(original.state), profiles = sortObjectKeys(original.profiles);
  const before = structuredClone(state);
  assert.notEqual(JSON.stringify(state.evaluations[0].catalogVersions), JSON.stringify(catalogReferences(state.catalog)));
  assert.equal(completedOperationalPair(state, state.conversations[0], profiles), true);
  assert.deepEqual(state, before);
});

test('one completed model or a partial, failed, pending or errored task never establishes full coverage', () => {
  for (const status of ['partial', 'failed', 'pending', 'running', 'interrupted', 'deferred']) {
    const { state, conversation, profiles } = fixture();
    state.tasks[1].status = status;
    assert.equal(completedOperationalPair(state, conversation, profiles), false, status);
  }
  const { state, conversation, profiles } = fixture();
  state.tasks[0].error = { code: 'AI_INCOMPLETE' };
  assert.equal(completedOperationalPair(state, conversation, profiles), false);
});

test('partial evaluation, validation errors and incomplete or duplicate variable results are not reused', () => {
  const mutations = [
    e => { e.partial = true; },
    e => { e.error = { code: 'AI_INCOMPLETE' }; },
    e => { e.validationErrors = [{ variableId: 'flag-a' }]; },
    e => { e.results.pop(); },
    e => { e.results[1] = structuredClone(e.results[0]); },
    e => { e.results[0].error = { code: 'INVALID_AI_RESULT' }; },
    e => { e.results[0].status = 'pending'; },
    e => { e.results[0].variableId = 'foreign-variable'; },
    e => { e.results = undefined; },
  ];
  for (const mutate of mutations) {
    const { state, conversation, profiles } = fixture();
    mutate(state.evaluations[1]);
    assert.equal(completedOperationalPair(state, conversation, profiles), false);
  }
});

test('historical complete results cannot replace a missing, foreign or superseded operational reference', () => {
  const missing = fixture();
  missing.state.operationalRefs = [];
  assert.equal(completedOperationalPair(missing.state, missing.conversation, missing.profiles), false);
  const foreign = fixture();
  foreign.state.operationalRefs[0].evaluationId = 'missing-evaluation';
  assert.equal(completedOperationalPair(foreign.state, foreign.conversation, foreign.profiles), false);
  const superseded = fixture();
  const newer = structuredClone(superseded.state.evaluations[0]);
  newer.id = 'newer-incomplete'; newer.jobId = 'newer-job'; newer.partial = true;
  superseded.state.evaluations.push(newer);
  superseded.state.jobs.push({ ...structuredClone(superseded.state.jobs[0]), id: newer.jobId });
  superseded.state.operationalRefs[0].evaluationId = newer.id;
  assert.equal(completedOperationalPair(superseded.state, superseded.conversation, superseded.profiles), false);
});

test('answers from comparisons, other tasks, other jobs or other conversations do not form the operational pair', () => {
  const mutations = [
    s => { s.jobs[0].purpose = 'comparison'; },
    s => { s.jobs[0].mode = 'single'; },
    s => { s.evaluations[1].purpose = 'comparison'; },
    s => { s.evaluations[1].taskId = 'foreign-task'; },
    s => { s.evaluations[1].jobId = 'foreign-job'; },
    s => { s.evaluations[1].conversationId = 'foreign-chat'; },
    s => { s.tasks[1].evaluationId = s.evaluations[0].id; },
    s => { s.tasks.push(structuredClone(s.tasks[1])); },
  ];
  for (const mutate of mutations) {
    const { state, conversation, profiles } = fixture(); mutate(state);
    assert.equal(completedOperationalPair(state, conversation, profiles), false);
  }
});

test('changed evaluable content and catalog versions require a fresh review', () => {
  for (const mutate of [
    f => { f.conversation.messages[0].text += ' añadido'; },
    f => { f.conversation.messages[0].timestamp = '2026-11-12T19:00:00.000Z'; },
    f => { f.conversation.country = 'PA'; },
    f => { f.conversation.completed = false; },
    f => { f.state.catalog[0].version++; },
    f => { f.state.catalog[0].active = false; },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(completedOperationalPair(f.state, f.conversation, f.profiles), false);
  }
});

test('changed task or evaluation prompt, rules and source context invalidate reuse', () => {
  for (const target of ['task', 'evaluation']) for (const field of ['sourceHash', 'catalogHash', 'promptHash', 'promptVersion', 'rulesVersion']) {
    const { state, conversation, profiles } = fixture();
    (target === 'task' ? state.tasks[1].context : state.evaluations[1])[field] = 'different';
    assert.equal(completedOperationalPair(state, conversation, profiles), false, `${target}.${field}`);
  }
});

test('a different model identity, configuration or fallback result cannot satisfy the requested pair', () => {
  const mutations = [
    f => { f.profiles[1].model = 'different-model'; },
    f => { f.profiles[1].configurationHash = digest('different'); },
    f => { f.state.tasks[1].profile.configurationHash = digest('different'); },
    f => { f.state.jobs[0].modelProfiles[1].configurationHash = digest('different'); },
    f => { f.state.evaluations[1].modelConfiguration.configurationHash = digest('different'); },
    f => { f.state.evaluations[1].usedFallback = true; },
    f => { f.state.evaluations[1].requestedProfileId = 'another-request'; },
    f => { f.state.evaluations[1].provider = 'other-provider'; },
    f => { f.profiles[1].model = f.profiles[0].model; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.equal(completedOperationalPair(f.state, f.conversation, f.profiles), false);
  }
});

test('native profile reuse requires matching native adapter and instruction provenance', () => {
  const { state, conversation, profiles } = fixture();
  const native = { protocol: 'systemone', adapterVersion: 'adapter-1', instructionsHash: digest('instructions') };
  Object.assign(profiles[0], native);
  Object.assign(state.tasks[0].profile, native);
  Object.assign(state.jobs[0].modelProfiles[0], native);
  Object.assign(state.evaluations[0].modelConfiguration, native);
  Object.assign(state.evaluations[0], native);
  assert.equal(completedOperationalPair(state, conversation, profiles), true);
  state.evaluations[0].instructionsHash = digest('changed-instructions');
  assert.equal(completedOperationalPair(state, conversation, profiles), false);
});

test('a repeated import of identical evaluable content remains reusable', () => {
  const { state, conversation, profiles } = fixture();
  conversation.sourceDocumentId = 'new-document-with-same-messages';
  conversation.ingestionBatchId = 'late-import';
  conversation.sourceCreatedAt = '2026-11-13T10:00:00.000Z';
  conversation.sourceUpdatedAt = '2026-11-13T11:00:00.000Z';
  conversation.ingestionStartedAt = '2026-11-13T10:00:00.000Z';
  const before = structuredClone(state);
  assert.equal(completedOperationalPair(state, conversation, profiles), true);
  assert.deepEqual(state, before);
});


function assignedFixture() {
  const f = fixture();
  f.state.settings = { thursdayHandoff: { id: 'test-thursday', runDate: '2026-11-13', scopeHash: 'test-scope', profiles: f.profiles } };
  f.options = { scheduleDate: '2026-11-13', dailyActivity: { handoffId: 'test-thursday', handoffScopeHash: 'test-scope' } };
  return f;
}

test('an assigned partial or failed input is not automatically retried on every scheduler tick', () => {
  for (const status of ['partial', 'failed', 'pending', 'running', 'interrupted']) {
    const f = assignedFixture();
    f.state.tasks.forEach(task => { task.status = status; });
    assert.equal(assignedHandoffVersion(f.state, f.conversation, f.options, f.state.jobs), true, status);
  }
});

test('a changed document is eligible for a new assignment while an identical reimport remains assigned', () => {
  const f = assignedFixture();
  f.conversation.sourceDocumentId = 'new-document-same-content';
  assert.equal(assignedHandoffVersion(f.state, f.conversation, f.options, f.state.jobs), true);
  f.conversation.messages[0].text += ' nuevo contenido';
  assert.equal(assignedHandoffVersion(f.state, f.conversation, f.options, f.state.jobs), false);
});

test('assignment identity requires both requested profiles and the exact evaluation context', () => {
  for (const mutate of [
    f => { f.state.tasks[1].profile.configurationHash = digest('other-profile'); },
    f => { f.state.tasks[1].context.promptHash = digest('other-prompt'); },
    f => { f.state.tasks[1].context.rulesVersion = 'different-rules'; },
    f => { f.state.tasks[1].context.catalogHash = digest('other-catalog'); },
    f => { f.state.tasks.pop(); },
    f => { f.options.dailyActivity.handoffScopeHash = 'another-scope'; },
  ]) {
    const f = assignedFixture(); mutate(f);
    assert.equal(assignedHandoffVersion(f.state, f.conversation, f.options, f.state.jobs), false);
  }
});
