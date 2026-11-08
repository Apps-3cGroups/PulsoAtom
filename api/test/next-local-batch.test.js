import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogV5 } from '../src/catalog-v5.js';
import { ModelRegistry } from '../src/model-registry.js';
import { catalogReferences } from '../src/evaluation-context.js';
import { dualizeEvaluation } from './fixtures/dual-state.js';
import { BATCH_ID, PREVIOUS_ID, newestUnevaluated, makePlan, assertPlan, assertPreviousFinished,
  assertFrozenConversations, originalRecords, originalsPreserved, batchStatus, existingCohortCoverage } from '../scripts/start-next-local-batch.js';

const FLAG = 'cliente_amenazo_cancelar_pedido';
const POSITIVE = 'cliente_felicito_al_asistente';
const fails = (fn, code) => assert.throws(fn, error => error.batchCode === code);
const conversation = (id, activity = '2026-11-08T05:00:00Z') => ({ id: String(id), country: 'HN', completed: false,
  date: '2026-11-07', lastActivityAt: activity, startedAt: '2026-11-08T04:00:00Z', endedAt: activity,
  client: { name: 'PRIVATE_SYNTHETIC_CLIENT' }, agent: { id: 'synthetic-agent', name: 'PRIVATE_SYNTHETIC_AGENT' }, topics: [], media: [],
  messages: [{ id: `message-${id}`, actor: 'cliente', text: 'PRIVATE_SYNTHETIC_TEXT', timestamp: activity }] });
function fixture() {
  const catalog = catalogV5.filter(v => [FLAG, POSITIVE].includes(v.id)).map(v => ({ ...structuredClone(v), active: true }));
  const state = { metadata: { demo: false }, settings: { dailyEnabled: false, evaluationMaintenance: null,
    aiPolicy: { mode: 'single', primaryId: 'gemma-local', version: 1 } }, catalog,
    catalogVersions: catalog.map(v => ({ id: `${v.id}:${v.version}`, itemId: v.id, version: v.version, snapshot: v })),
    conversations: Array.from({ length: 502 }, (_, i) => conversation(i + 1)), evaluations: [], tasks: [], attempts: [], jobs: [],
    comparisons: [], operationalRefs: [], reviews: [], verdicts: [] };
  const registry = new ModelRegistry(['gemma-local', 'clef-local'].map(id => ({ id, provider: 'gateway', model: `synthetic-${id}`,
    enabled: true, evaluator: { configured: true, protocol: 'chat', toolKey: 'synthetic-tool', baseUrl: 'http://synthetic.invalid',
      async evaluate() { throw new Error('Pure planning must never call a model'); } } })));
  return { state, registry };
}

test('the plan freezes exactly the newest 500 never-evaluated conversations without writing state or storing transcripts', () => {
  const { state, registry } = fixture();
  state.evaluations.push({ id: 'old-comparison', purpose: 'comparison', conversationId: '502' },
    { id: 'old-operational', purpose: 'operational', conversationId: '501' });
  const before = structuredClone(state), plan = makePlan(state, registry);
  assertPlan(plan);
  assert.equal(plan.id, BATCH_ID);
  assert.equal(plan.conversations.length, 500);
  assert.deepEqual(plan.conversations.slice(0, 3).map(c => c.id), ['500', '499', '498']);
  assert.equal(plan.conversations.at(-1).id, '1');
  assert.deepEqual(plan.profiles.map(p => p.id), ['gemma-local', 'clef-local']);
  assert.equal(plan.conversations.every(c => c.sourceHash && c.catalogHash && c.promptHash && c.rulesVersion), true);
  assert.equal(JSON.stringify(plan).includes('PRIVATE_SYNTHETIC'), false);
  assert.deepEqual(state, before);
});

test('selection uses activity and numeric IDs, includes open cases and falls back to message dates', () => {
  const { state } = fixture();
  state.conversations = [conversation('9'), conversation('10'), conversation('11', '2026-11-09T05:00:00Z')];
  state.conversations[0].lastActivityAt = null;
  const selected = newestUnevaluated(state, 3);
  assert.deepEqual(selected.map(c => c.id), ['11', '10', '9']);
  assert.equal(selected.every(c => c.completed === false), true);
});

test('planning rejects insufficient data, demo mode, duplicate source IDs and nonlocal or duplicate models', () => {
  for (const [mutate, code] of [
    [f => { f.state.conversations = f.state.conversations.slice(0, 499); }, 'INSUFFICIENT_NEW_CONVERSATIONS'],
    [f => { f.state.metadata.demo = true; }, 'REAL_MODE_REQUIRED'],
    [f => { f.state.conversations = Array.from({ length: 500 }, () => conversation('duplicate')); }, 'INSUFFICIENT_NEW_CONVERSATIONS'],
    [f => { f.registry.profiles[1].provider = 'gemini'; }, 'LOCAL_MODELS_REQUIRED'],
    [f => { f.registry.profiles[1].model = f.registry.profiles[0].model; }, 'LOCAL_MODELS_REQUIRED'],
  ]) {
    const f = fixture(); mutate(f);
    fails(() => makePlan(f.state, f.registry), code);
  }
});

test('the manifest rejects changed scope, versions and baseline without executing a new model call', () => {
  for (const mutate of [p => { p.id = PREVIOUS_ID; }, p => { p.conversations.pop(); },
    p => { p.conversations[0].sourceHash = 'changed'; }, p => { p.profiles[0].model = 'changed'; },
    p => { p.baseline.evaluations.push({ id: 'changed', hash: 'changed' }); }]) {
    const f = fixture(), plan = makePlan(f.state, f.registry); mutate(plan);
    fails(() => assertPlan(plan), 'INVALID_MANIFEST');
  }
});

test('every source read is bound to the frozen content and rejects drift before task creation', () => {
  const f = fixture(), plan = makePlan(f.state, f.registry), id = plan.conversations[0].id;
  assertFrozenConversations(f.state, plan, [id], { requireUnevaluated: true });
  f.state.evaluations.push({ id: 'new-gemma-result', conversationId: id });
  fails(() => assertFrozenConversations(f.state, plan, [id], { requireUnevaluated: true }), 'SOURCE_CHANGED');
  assertFrozenConversations(f.state, plan, [id]); // Clef may read the same content after Gemma was saved.
  f.state.conversations.find(c => c.id === id).messages[0].text += ' SOURCE_UPDATED';
  fails(() => assertFrozenConversations(f.state, plan, [id]), 'SOURCE_CHANGED');
  assert.throws(() => assertFrozenConversations(f.state, plan, [id]), error => error.code === 'SOURCE_CHANGED' && error.status === 409);
  fails(() => assertFrozenConversations(f.state, plan, ['not-in-frozen-scope']), 'SOURCE_CHANGED');
  const g = fixture(), stable = makePlan(g.state, g.registry);
  g.state.catalog[0].version++;
  fails(() => assertFrozenConversations(g.state, stable, [stable.conversations[0].id]), 'SOURCE_CHANGED');
});

test('append-only preservation checks every historical row and detects mutations or removals', () => {
  const { state } = fixture();
  state.evaluations.push({ id: 'old', conversationId: 'old-chat', results: [{ value: 1 }] });
  state.reviews.push({ id: 'old-review', action: 'refutar' });
  const baseline = originalRecords(state);
  state.evaluations.push({ id: 'new', conversationId: 'new-chat' });
  assert.equal(originalsPreserved(state, baseline), true);
  state.evaluations[0].results[0].value = 0;
  assert.equal(originalsPreserved(state, baseline), false);
  state.evaluations[0].results[0].value = 1;
  state.reviews = [];
  assert.equal(originalsPreserved(state, baseline), false);
});

test('previous maintenance must be terminal and stopped before claiming the new cohort', () => {
  const { state } = fixture();
  state.settings.evaluationMaintenance = PREVIOUS_ID;
  const previous = { cohortId: `clef-complement-${PREVIOUS_ID}`, status: 'partial', finishedBatches: 25, finishedAt: '2026-11-08T05:00:00Z' };
  state.jobs = Array.from({ length: 25 }, (_, i) => ({ id: `old-job-${i}`, cohortId: previous.cohortId, status: 'partial' }));
  state.tasks = state.jobs.flatMap(job => Array.from({ length: 40 }, (_, i) => ({ id: `${job.id}-${i}`, jobId: job.id, status: i ? 'completed' : 'partial' })));
  assertPreviousFinished(state, previous, false);
  fails(() => assertPreviousFinished(state, previous, true), 'PREVIOUS_MAINTENANCE_NOT_FINISHED');
  state.tasks[0].status = 'pending';
  fails(() => assertPreviousFinished(state, previous, false), 'PREVIOUS_COHORT_NOT_FINISHED');
  state.tasks[0].status = 'running';
  fails(() => assertPreviousFinished(state, previous, false), 'EVALUATION_RUNNING');
  state.settings.dailyEnabled = true;
  fails(() => assertPreviousFinished(state, previous, false), 'DAILY_MUST_BE_PAUSED');
});

test('status reports both model totals and blocked state without exposing raw errors or changing saved answers', () => {
  const { state, registry } = fixture(), plan = makePlan(state, registry);
  state.settings.evaluationMaintenance = BATCH_ID;
  state.jobs.push({ id: 'new-job', idempotencyKey: BATCH_ID, status: 'running', modelProfiles: plan.profiles });
  state.tasks = plan.profiles.flatMap(profile => Array.from({ length: 500 }, (_, i) => ({ id: `${profile.id}-${i}`,
    jobId: 'new-job', profile, status: profile.id === 'gemma-local' ? i ? 'completed' : 'partial' : 'pending',
    error: { code: 'INVALID_AI_RESULT', message: 'PRIVATE_SYNTHETIC_ERROR' } })));
  Object.assign(plan, { status: 'blocked', errorCode: 'SOURCE_CHANGED' });
  const before = structuredClone(state), status = batchStatus(state, plan, false);
  assert.equal(status.status, 'blocked');
  assert.equal(status.totalReviews, 1000);
  assert.equal(status.totalConversations, 500);
  assert.deepEqual(status.progress.map(p => [p.profileId, p.total, p.completed, p.partial, p.pending]),
    [['gemma-local', 500, 499, 1, 0], ['clef-local', 500, 0, 0, 500]]);
  assert.equal(status.originalRecordsPreserved, true);
  assert.equal(JSON.stringify(status).includes('PRIVATE_SYNTHETIC'), false);
  assert.deepEqual(state, before);
});

test('coverage inspects only the previous exact 500 and returns safe execution/flag aggregates', () => {
  const { state } = fixture();
  const previous = { cohortId: `clef-complement-${PREVIOUS_ID}`, conversationIds: state.conversations.slice(0, 500).map(c => c.id) };
  state.conversations = state.conversations.slice(0, 3);
  for (const [index, source] of state.conversations.slice(0, 2).entries()) {
    const evaluation = { id: `coverage-${index}`, conversationId: source.id, partial: false, createdAt: '2026-11-08T05:00:00Z',
      catalogVersions: catalogReferences(state.catalog), results: state.catalog.map(v => ({ variableId: v.id, type: v.type,
        method: v.method, status: 'evaluado', value: index === 0 ? 1 : 0, reason: 'PRIVATE_SYNTHETIC_REASON', evidence: [] })) };
    source.evaluationId = evaluation.id; state.evaluations.push(evaluation);
    const { second } = dualizeEvaluation(state, source, evaluation);
    if (index) {
      second.partial = true;
      second.results[0].error = { code: 'INVALID_AI_RESULT', message: 'PRIVATE_SYNTHETIC_ERROR' };
    }
  }
  const before = structuredClone(state), result = existingCohortCoverage(state, previous);
  assert.deepEqual(result, { available: true, total: 500, sourceMissing: 497, evaluated: 1, review_pending: 0, partial: 1,
    not_evaluated: 498, withAlerts: 1, withCritical: 1, withNormal: 0, withPositives: 1,
    criticalFlags: 1, normalFlags: 0, positiveFlags: 1, withDualFlags: 1, dualFlags: 2, sourceChanged: 0 });
  assert.equal(JSON.stringify(result).includes('PRIVATE_SYNTHETIC'), false);
  assert.deepEqual(state, before);
  previous.conversationIds.pop();
  fails(() => existingCohortCoverage(state, previous), 'PREVIOUS_MANIFEST_INVALID');
});
