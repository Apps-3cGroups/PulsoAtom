import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { catalogV5 } from '../src/catalog-v5.js';
import { catalogReferences, digest, historicalProfileId } from '../src/evaluation-context.js';
import { operationalEvaluation, operationalConsensus } from '../src/operational-evaluation.js';
import { conversationView, recordReview, summarize, viewContext } from '../src/domain.js';
import { enableNavigationSummaryCache } from '../src/navigation-cache.js';
import { dualizeEvaluation } from './fixtures/dual-state.js';
import { navigationSummaryProjection, decodeNavigationSummary } from '../src/navigation-projection.js';
import { jsonRemoveProjection } from './fixtures/navigation-projection.js';

const FLAG = 'cliente_amenazo_cancelar_pedido';
const POSITIVE = 'cliente_felicito_al_asistente';
const CODE = 'primera_respuesta_humano_mayor_5_min';
const DESCRIPTOR = 'tipo_interaccion';
function fixture({ changed = true } = {}) {
  const state = createState(false);
  state.settings.evaluationMaintenance = 'user-pause-meeting-20261125';
  state.catalog = catalogV5.filter(v => [FLAG, POSITIVE, CODE, DESCRIPTOR].includes(v.id))
    .map(v => ({ ...structuredClone(v), active: true }));
  state.catalogVersions = state.catalog.map(v => ({ id: `${v.id}:${v.version}`, itemId: v.id, version: v.version, snapshot: v }));
  const conversation = { id: 'historical-synthetic', country: 'HN', date: '2026-11-18', activityDate: '2026-11-18',
    completed: false, startedAt: '2026-11-18T15:00:00Z', activityAt: '2026-11-18T15:01:00Z',
    client: { name: 'Cliente sintético' }, agent: { id: 'synthetic-agent', name: 'Asesor sintético' }, media: [], topics: [],
    evaluationId: 'historical-evaluation', messages: [{ id: 'synthetic-message', actor: 'cliente', text: 'Consulta sintética.', timestamp: '2026-11-18T15:00:00Z' }] };
  const evaluation = { id: conversation.evaluationId, conversationId: conversation.id, createdAt: '2026-11-20T12:00:00Z',
    partial: false, provisional: true, catalogVersions: catalogReferences(state.catalog), results: state.catalog.map(v => ({
      variableId: v.id, type: v.type, method: v.method, status: v.id === CODE ? 'no_evaluado' : 'evaluado',
      value: v.id === CODE ? null : v.id === DESCRIPTOR ? 'pedido' : 1,
      evidence: v.id === FLAG ? [{ messageId: 'synthetic-message', quote: 'Consulta sintética.' }] : [], reason: 'Resultado sintético guardado.',
      ...(v.id === CODE ? { codeRule: 'business-hours' } : {}),
    })) };
  state.conversations.push(conversation); state.evaluations.push(evaluation);
  const pair = dualizeEvaluation(state, conversation);
  const job = state.jobs.find(j => j.id === pair.jobId);
  job.promptSnapshot = { hash: digest('saved-prompts'), profiles: {} };
  pair.profiles.forEach((profile, index) => {
    Object.assign(profile, { id: index ? 'gemma-local' : 'clef-local', label: index ? 'Gemma' : 'Clef', provider: 'gateway',
      model: index ? 'gemma-4-26b-a4b-it-mlx' : 'clef-flash' });
    profile.configurationHash = digest(profile);
    const answer = index ? pair.second : pair.first, promptHash = digest(profile.id);
    Object.assign(answer, { profileId: profile.id, requestedProfileId: profile.id, provider: profile.provider, model: profile.model,
      modelConfiguration: structuredClone(profile), validationErrors: [], promptHash: job.promptSnapshot.hash,
      modelPromptHash: promptHash, createdAt: index ? '2026-11-21T12:00:00Z' : '2026-11-20T12:00:00Z' });
    job.promptSnapshot.profiles[profile.id] = { hash: promptHash };
    state.tasks.find(t => t.evaluationId === answer.id).context = { modelPromptHash: promptHash };
  });
  if (changed) conversation.messages[0].text += ' Cambio posterior en Atom.';
  return { state, conversation, job, ...pair, secondTask: state.tasks.find(t => t.evaluationId === pair.second.id) };
}
const detail = f => conversationView(f.state, f.conversation, undefined, true);

test('stored historical agreement is visible separately, with exact saved provenance and no mutation', () => {
  const f = fixture(), before = structuredClone(f.state);
  const projection = operationalEvaluation(f.state, f.first);
  assert.equal(operationalConsensus(projection, FLAG).detected, false);
  assert.equal(operationalConsensus(projection, FLAG).historicalDetected, true);
  for (const full of [false, true]) {
    const view = conversationView(f.state, f.conversation, undefined, full);
    assert.equal(view.historicalFlagsAvailable, true);
    assert.equal(view.sourceChanged, true);
    assert.equal(view.bothModelsComplete, true);
    assert.equal(view.critical, 0); assert.equal(view.positive, 0); assert.equal(view.dualDetected, false);
    assert.deepEqual(view.marks, []);
    assert.equal(view.historicalMarks.length, 2);
    const mark = view.historicalMarks.find(m => m.id === FLAG);
    assert.equal(mark.effective, false); assert.equal(mark.historical, true);
    assert.equal(mark.dualDetected, false); assert.equal(mark.historicalDualDetected, true);
    assert.equal(mark.createdAt, f.second.createdAt);
    assert.equal(mark.comparison.agreement, 'agree-positive');
    assert.deepEqual(mark.models.map(m => [m.profileId, m.evaluationId, m.createdAt, m.sourceHash]),
      [f.first, f.second].map(e => [e.profileId, e.id, e.createdAt, e.sourceHash]));
    assert.equal(summarize([view]).withAlerts, 0);
  }
  const view = detail(f), flag = view.variables.find(v => v.id === FLAG);
  assert.equal(flag.historicalAutomaticFlagVisible, true);
  assert.equal(flag.historicalKind, 'critical');
  assert.equal(flag.automaticFlagVisible, false); assert.equal(flag.kind, null);
  assert.equal(flag.result.comparison.sourceChanged, true);
  assert.equal(view.evaluation.sourceHash, f.first.sourceHash);
  assert.deepEqual(flag.result.comparison.cells.map(c => c.result.evidence), [f.first, f.second].map(e => e.results.find(r => r.variableId === FLAG).evidence));
  assert.deepEqual(f.state, before);
});

test('current results and raw single-model views do not duplicate into historical marks', () => {
  const f = fixture({ changed: false });
  assert.equal(detail(f).sourceChanged, false);
  assert.equal(detail(f).marks.length, 2);
  assert.deepEqual(detail(f).historicalMarks, []);
  f.conversation.messages[0].text += ' Cambio.';
  const raw = conversationView(f.state, f.conversation, viewContext(f.state, historicalProfileId(f.first)), true);
  assert.equal(raw.sourceChanged, true); assert.deepEqual(raw.historicalMarks, []);
  assert.equal(raw.historicalFlagsAvailable, false);
  assert.ok(raw.variables.every(v => v.historicalAutomaticFlagVisible === false));
});

test('historical marks exclude disagreement, abstention, imposed code, errors and foreign contracts', () => {
  const mutations = {
    disagreement: f => { f.second.results.find(r => r.variableId === FLAG).value = 0; },
    abstention: f => { Object.assign(f.second.results.find(r => r.variableId === FLAG), { value: null, status: 'no_evaluado' }); },
    sharedRule: f => { f.second.results.find(r => r.variableId === FLAG).codeRule = 'shared-rule'; },
    code: f => { for (const e of [f.first, f.second]) e.results.find(r => r.variableId === FLAG).method = 'Código'; },
    resultError: f => { f.second.results.find(r => r.variableId === FLAG).error = { code: 'INVALID_AI_RESULT' }; },
    technicalErrorElsewhere: f => { f.second.results.find(r => r.variableId === DESCRIPTOR).error = { code: 'INVALID_AI_RESULT' }; },
    partial: f => { f.second.partial = true; },
    taskPending: f => { f.secondTask.status = 'pending'; },
    fallback: f => { f.second.usedFallback = true; },
    source: f => { f.second.sourceHash = digest('another-source'); },
    catalog: f => { f.second.catalogHash = digest('another-catalog'); },
    prompt: f => { f.second.promptHash = digest('another-prompt'); },
    profilePrompt: f => { f.second.modelPromptHash = digest('another-profile-prompt'); },
    configuration: f => { f.second.modelConfiguration.configurationHash = digest('another-configuration'); },
    requestedProfile: f => { f.second.requestedProfileId = 'another-profile'; },
    taskProfile: f => { f.secondTask.profile = { ...f.secondTask.profile, configurationHash: digest('another-task-configuration') }; },
    duplicateEvaluation: f => { f.state.evaluations.push(structuredClone(f.second)); },
    duplicateTask: f => { f.state.tasks.push({ ...structuredClone(f.secondTask), id: 'duplicate-task' }); },
    foreignModel: f => { f.second.model = 'foreign-model'; },
    duplicateModel: f => { f.second.model = f.first.model; },
    inactive: f => { f.second.catalogVersions.find(v => v.id === FLAG).active = false; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const f = fixture(); mutate(f);
    const before = structuredClone(f.state), view = detail(f);
    assert.equal(view.sourceChanged, true, name);
    assert.equal(view.historicalMarks.some(m => m.id === FLAG), false, name);
    assert.equal(view.variables.find(v => v.id === FLAG).historicalAutomaticFlagVisible, false, name);
    if (['requestedProfile', 'taskProfile', 'duplicateEvaluation', 'duplicateTask', 'partial', 'taskPending'].includes(name)) {
      assert.equal(view.historicalFlagsAvailable, false, name);
    }
    assert.deepEqual(f.state, before, name);
  }
});

test('unverified saved comparison labels cannot invent historical consensus', () => {
  const f = fixture(); f.state.jobs = [];
  f.first.results.find(r => r.variableId === FLAG).comparison = { agreement: 'agree-positive', votes: 2, detections: 2, sourceChanged: true };
  assert.deepEqual(detail(f).historicalMarks, []);
  assert.equal(detail(f).historicalFlagsAvailable, false);
});

test('human decisions remain authoritative and changed-source reviews remain blocked', () => {
  for (const action of ['refutar', 'levantar']) {
    const f = fixture();
    f.state.reviews.push({ id: 'saved-review', conversationId: f.conversation.id, evaluationId: f.first.id, variableId: FLAG,
      action, createdAt: '2026-11-22T12:00:00Z' });
    const before = structuredClone(f.state), view = detail(f);
    assert.equal(view.historicalMarks.some(m => m.id === FLAG), false);
    assert.equal(view.marks.filter(m => m.id === FLAG).length, 1);
    assert.equal(view.marks.find(m => m.id === FLAG).kind, action === 'refutar' ? 'refuted' : 'human');
    assert.throws(() => recordReview(f.state, f.conversation.id, { variableId: FLAG, evaluationId: f.first.id, action: 'deshacer' },
      { id: 'synthetic-user', name: 'Supervisor' }), { code: 'SOURCE_CHANGED' });
    assert.deepEqual(f.state, before);
  }
});

test('navigation cache invalidates historical presentation when source or saved provenance changes', () => {
  const f = fixture({ changed: false }), cache = new Map();
  const summary = () => { enableNavigationSummaryCache(f.state, cache); return conversationView(f.state, f.conversation); };
  assert.deepEqual(summary().historicalMarks, []);
  f.conversation.messages[0].text += ' Cambio.';
  assert.equal(summary().historicalMarks.length, 2);
  f.secondTask.status = 'pending';
  assert.deepEqual(summary().historicalMarks, []);
  assert.ok(f.state.evaluations.every(e => !Object.hasOwn(e, 'historicalMarks')));
});

test('summary projection preserves current and historical flags, statuses, counts and exact provenance', () => {
  for (const changed of [false, true]) {
    const f = fixture({ changed });
    for (const evaluation of f.state.evaluations) evaluation.promptSnapshot = { text: 'Frozen instructions', hash: evaluation.modelPromptHash };
    for (const task of f.state.tasks) { task.profileStates = { retained: { results: f.first.results } }; task.codeResults = []; }
    f.job.runtimeConfiguration = { 'clef-local': { promptText: 'Frozen runtime' } };
    for (const profile of Object.values(f.job.promptSnapshot.profiles)) Object.assign(profile, { text: 'Frozen text', itemPrompts: { flag: 'Frozen item prompt' }, promptText: 'Configured' });
    const projected = structuredClone(f.state);
    for (const key of ['evaluations', 'tasks', 'jobs']) projected[key] = projected[key].map(row => decodeNavigationSummary(key, jsonRemoveProjection(row, navigationSummaryProjection(key))));
    assert.deepEqual(conversationView(projected, projected.conversations[0]), conversationView(f.state, f.conversation));
    assert.ok(f.first.results.some(result => result.evidence?.length));
    assert.ok(projected.evaluations.every(evaluation => evaluation.results.every(result => !result.evidence && !result.reason)));
  }
});
