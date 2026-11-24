import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createState } from '../src/data/seed.js';
import { dualizeEvaluation } from './fixtures/dual-state.js';
import { applyReviewSelection, publicReviewSelection } from '../src/review-selection.js';
import { conversationView, filteredConversations, listQuerySchema } from '../src/domain.js';
import { AtomHistoryStore } from '../src/store.js';
import { createApp } from '../src/app.js';

function fixture() {
  const state = createState(true);
  const conversation = state.conversations.find(c => c.evaluationId);
  const { first, second, jobId } = dualizeEvaluation(state, conversation);
  for (const evaluation of [first, second]) {
    evaluation.partial = false; evaluation.demo = false; evaluation.requestedProfileId = evaluation.profileId;
    evaluation.catalogVersions = evaluation.catalogVersions.filter(ref => evaluation.results.some(result => result.variableId === ref.id));
    evaluation.results = evaluation.results.map(result => ({ ...result, error: undefined }));
  }
  state.reviewSelection = { id: 'review-fixture', title: 'Revisión guardada', caseCount: 1,
    scope: { from: '2026-11-17', to: '2026-11-19' }, reviewDeadline: '2026-11-25T10:00:00-06:00', cases: [{
      conversationId: conversation.id, country: conversation.country, activityDate: '2026-11-18', activityAt: '2026-11-18T16:00:00.000Z',
      jobId, publishedAnchorEvaluationId: first.id, sourceHash: first.sourceHash,
      context: Object.fromEntries(['catalogHash', 'promptHash', 'promptVersion', 'rulesVersion'].map(key => [key, first[key]])),
      models: [first, second].map(e => ({ evaluationId: e.id, taskId: e.taskId, profileId: e.profileId, provider: e.provider, model: e.model })),
    }] };
  return { state, conversation, first, second };
}

test('fixed selection pins membership, original pair and date without mutating current publication', () => {
  const { state, conversation, first, second } = fixture();
  state.operationalRefs = [{ id: conversation.id, evaluationId: 'new-publication' }];
  state.tasks.find(task => task.id === second.taskId).evaluationId = 'new-second-result';
  state.tasks.find(task => task.id === second.taskId).status = 'pending';
  conversation.activityDate = '2026-12-01'; conversation.activityAt = '2026-12-01T12:00:00.000Z';
  const before = structuredClone(state);
  const selected = applyReviewSelection(state, 'review-fixture');
  assert.equal(selected.conversations.length, 1);
  assert.deepEqual(selected.evaluations.map(e => e.id), [first.id, second.id]);
  assert.equal(selected.operationalRefs[0].evaluationId, first.id);
  const view = conversationView(selected, selected.conversations[0], undefined, true);
  assert.equal(view.evaluation.dual, true);
  assert.equal(view.evaluation.modelReviews.length, 2);
  const matches = filteredConversations(selected, listQuerySchema.parse({ from: '2026-11-17', to: '2026-11-19' }));
  assert.equal(matches.length, 1); assert.equal(matches[0].displayDate, '2026-11-18');
  const startedQuery = filteredConversations(selected, listQuerySchema.parse({ dateBasis: 'started' }));
  assert.equal(startedQuery[0].displayDate, '2026-11-18');
  assert.equal(startedQuery[0].dateBasis, 'activity');
  assert.equal(filteredConversations(selected, listQuerySchema.parse({ country: 'ZZ' })).length, 0);
  assert.deepEqual(state, before);
});

test('changed source remains visible and original hashes are never relabeled', () => {
  const { state, conversation, first } = fixture();
  conversation.messages[0].timestamp = '2026-11-18T18:00:00.000Z';
  const selected = applyReviewSelection(state, 'review-fixture');
  const view = conversationView(selected, selected.conversations[0], undefined, true);
  assert.equal(view.sourceChanged, true);
  assert.equal(view.evaluation.sourceHash, first.sourceHash);
  assert.equal(selected.metadata.reviewSelection.sourceChangedCount, 1);
});

test('unknown selections and incomplete or mismatched pairs fail closed', () => {
  const { state, second } = fixture();
  assert.throws(() => applyReviewSelection(state, 'missing'), { status: 404, code: 'REVIEW_SELECTION_NOT_FOUND' });
  for (const mutate of [
    draft => draft.conversations.splice(draft.conversations.findIndex(c => c.id === draft.reviewSelection.cases[0].conversationId), 1),
    draft => { draft.evaluations.find(e => e.id === second.id).sourceHash = 'changed'; },
    draft => { draft.evaluations.find(e => e.id === second.id).model = 'another-model'; },
    draft => { draft.evaluations.find(e => e.id === second.id).partial = true; },
    draft => { draft.evaluations.find(e => e.id === second.id).error = { code: 'INVALID_AI_RESULT' }; },
    draft => { draft.evaluations.find(e => e.id === second.id).validationErrors = ['Invalid response']; },
    draft => { draft.evaluations.find(e => e.id === second.id).demo = true; },
    draft => { draft.evaluations.find(e => e.id === second.id).usedFallback = true; },
    draft => { draft.evaluations.find(e => e.id === second.id).requestedProfileId = 'another-profile'; },
    draft => { draft.reviewSelection.cases[0].context.catalogHash = 'different-catalog'; },
    draft => { draft.reviewSelection.cases[0].context.promptHash = 'different-prompt'; },
    draft => { draft.reviewSelection.cases[0].context.promptVersion = 'different-prompt-version'; },
    draft => { draft.reviewSelection.cases[0].context.rulesVersion = 'different-rules'; },
    draft => { draft.tasks.find(task => task.id === second.taskId).profile = { ...draft.tasks.find(task => task.id === second.taskId).profile, configurationHash: 'another-configuration' }; },
    draft => { draft.evaluations.find(e => e.id === second.id).results[0].error = { code: 'INVALID_AI_RESULT' }; },
  ]) {
    const draft = structuredClone(state); mutate(draft);
    assert.throws(() => applyReviewSelection(draft, 'review-fixture'), { status: 409, code: 'REVIEW_SELECTION_INCOMPLETE' });
  }
});

test('bootstrap metadata exposes counts, dates and deadline without manifest identifiers or hashes', () => {
  const { state } = fixture();
  const metadata = publicReviewSelection(state);
  assert.deepEqual(Object.keys(metadata).sort(), ['id', 'title', 'from', 'to', 'count', 'countries', 'reviewAt', 'sourceChangedCount', 'timeCorrectionCount'].sort());
  assert.equal(metadata.count, 1); assert.equal(metadata.countries[0].count, 1);
  assert.equal(publicReviewSelection({}), null);
});

test('Atom reader loads only selected IDs and does not invoke full-history navigation', async () => {
  const { state, conversation } = fixture(); const calls = [];
  const store = new AtomHistoryStore({
    async readNavigation(ids) { calls.push(ids); return structuredClone(state); },
    async read() { throw new Error('full read forbidden'); },
  }, {
    async read(options) { assert.deepEqual(options, { conversationIds: [conversation.id] }); return { conversations: [structuredClone(conversation)], countries: [], loadedAt: '2026-11-24T00:00:00Z' }; },
    async readOverview() { throw new Error('overview forbidden'); },
  });
  const selected = await store.readForNavigation({ reviewSelection: 'review-fixture' });
  assert.equal(selected.conversations.length, 1);
  assert.deepEqual(calls, [[], [conversation.id]]);
});

test('authenticated routes share exact selection and keep model-view permissions', async () => {
  const { state, conversation } = fixture();
  const store = { async read() { return structuredClone(state); }, async transaction(fn) { return fn(state); } };
  const app = createApp(store, { demo: true, origin: 'http://127.0.0.1:3000', timezone: 'America/Tegucigalpa', sessionHours: 8 });
  const client = request.agent(app);
  await request(app).get('/pulsoAtom/api/summary?reviewSelection=review-fixture').expect(401);
  await client.post('/pulsoAtom/api/auth/demo').send({ role: 'supervisor' }).expect(200);
  const bootstrap = await client.get('/pulsoAtom/api/bootstrap').expect(200);
  assert.equal(bootstrap.body.reviewSelection.id, 'review-fixture');
  const summary = await client.get('/pulsoAtom/api/summary?reviewSelection=review-fixture&from=2026-11-17&to=2026-11-19').expect(200);
  assert.deepEqual(summary.body.conversations.map(c => c.id), [conversation.id]);
  const list = await client.get('/pulsoAtom/api/conversations?reviewSelection=review-fixture').expect(200);
  assert.equal(list.body.total, 1);
  const detail = await client.get(`/pulsoAtom/api/conversations/${conversation.id}?reviewSelection=review-fixture`).expect(200);
  assert.equal(detail.body.conversation.evaluation.modelReviews.length, 2);
  await client.get('/pulsoAtom/api/conversations/outside?reviewSelection=review-fixture').expect(404);
  await client.get('/pulsoAtom/api/summary?reviewSelection=unknown').expect(404);
  await client.get('/pulsoAtom/api/summary?reviewSelection=review-fixture&modelProfileId=synthetic-first').expect(403);
});


test('an explicit completed selection anchor supersedes a published partial from the same task without changing it', () => {
  const { state, first, conversation } = fixture();
  const original = { ...structuredClone(first), id: 'published-partial', partial: true, validationErrors: ['Invalid response'] };
  original.results[0].error = { code: 'INVALID_AI_RESULT' };
  state.evaluations.push(original);
  state.operationalRefs = [{ id: conversation.id, evaluationId: original.id }];
  state.reviewSelection.cases[0].publishedAnchorEvaluationId = original.id;
  state.reviewSelection.cases[0].selectionAnchorEvaluationId = first.id;
  const before = structuredClone(state);
  const selected = applyReviewSelection(state, 'review-fixture');
  assert.equal(selected.operationalRefs[0].evaluationId, first.id);
  const view = conversationView(selected, selected.conversations[0], undefined, true);
  assert.equal(view.evaluation.modelReviews.length, 2);
  assert.ok(view.evaluation.modelReviews.every(model => model.status === 'completed'));
  assert.deepEqual(state, before);
  original.sourceHash = 'different-source';
  assert.throws(() => applyReviewSelection(state, 'review-fixture'), { status: 409, code: 'REVIEW_SELECTION_INCOMPLETE' });
});
