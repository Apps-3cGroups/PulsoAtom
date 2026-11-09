import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogV5 } from '../src/catalog-v5.js';
import { ModelRegistry } from '../src/model-registry.js';
import { catalogReferences, evaluationContext } from '../src/evaluation-context.js';
import { BATCH_ID, makePlan, localBatchAudit } from '../scripts/start-next-local-batch.js';
import { evaluationBatchAudit } from '../src/evaluation-batch-audit.js';
import { inspectEvaluationBatch, parseArguments, safeAuditFailure } from '../scripts/inspect-evaluation-batch.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FLAG = 'cliente_amenazo_cancelar_pedido', NORMAL = 'cliente_abandono', POSITIVE = 'cliente_felicito_al_asistente';
const CHECKED = '2026-11-08T09:00:00Z';
function fixture() {
  const catalog = catalogV5.filter(v => [FLAG, NORMAL, POSITIVE].includes(v.id)).map(v => ({ ...structuredClone(v), active: true }));
  const state = { metadata: { demo: false }, settings: { dailyEnabled: false, aiPolicy: { version: 1 } }, catalog,
    catalogVersions: catalog.map(v => ({ id: `${v.id}:${v.version}`, itemId: v.id, version: v.version, snapshot: v })),
    conversations: Array.from({ length: 500 }, (_, i) => ({ id: `PRIVATE_CHAT_${i}`, country: 'HN',
      client: { name: 'PRIVATE_CLIENT' }, agent: { id: 'PRIVATE_AGENT', name: 'PRIVATE_NAME' },
      startedAt: '2026-11-08T05:00:00Z', lastActivityAt: '2026-11-08T06:00:00Z', completed: false, media: [], topics: [],
      messages: [{ id: `PRIVATE_MESSAGE_${i}`, actor: 'cliente', text: 'PRIVATE_TRANSCRIPT', timestamp: '2026-11-08T06:00:00Z' }] })),
    evaluations: [], tasks: [], attempts: [], jobs: [], comparisons: [], operationalRefs: [], reviews: [], verdicts: [] };
  const registry = new ModelRegistry(['gemma-local', 'clef-local'].map(id => ({ id, provider: 'gateway', model: id,
    enabled: true, evaluator: { configured: true, protocol: 'chat', toolKey: 'PRIVATE_TOOL', baseUrl: 'http://private.invalid',
      evaluate() { throw new Error('This audit must never execute a model'); } } })));
  const manifest = makePlan(state, registry);
  const job = { id: 'PRIVATE_JOB', idempotencyKey: BATCH_ID, purpose: 'operational', mode: 'dual', modelProfiles: manifest.profiles,
    conversationIds: manifest.conversations.map(c => c.id), catalogVersions: catalogReferences(catalog), status: 'running' };
  state.jobs.push(job);
  state.tasks = job.conversationIds.flatMap(id => manifest.profiles.map(profile => ({ id: `PRIVATE_TASK_${id}_${profile.id}`,
    jobId: job.id, conversationId: id, profile, status: 'pending', evaluationId: null })));
  function save(index, profileId, values = {}, error) {
    const source = state.conversations[index], task = state.tasks.find(t => t.conversationId === source.id && t.profile.id === profileId);
    const evaluation = { id: `PRIVATE_EVAL_${task.id}`, taskId: task.id, jobId: job.id, purpose: 'operational',
      conversationId: source.id, profileId, provider: task.profile.provider, model: task.profile.model, modelConfiguration: task.profile,
      ...evaluationContext(source, catalog), catalogVersions: job.catalogVersions, partial: !!error, createdAt: '2026-11-08T08:00:00Z',
      results: catalog.map(v => ({ variableId: v.id, type: v.type, method: v.method,
        status: values[v.id] === null ? 'no_evaluado' : 'evaluado', value: Object.hasOwn(values, v.id) ? values[v.id] : 0,
        evidence: [], reason: 'PRIVATE_REASON', ...(error && v.id === FLAG ? { error } : {}) })) };
    task.status = error ? 'partial' : 'completed'; task.evaluationId = evaluation.id; task.error = error || null;
    state.evaluations.push(evaluation);
    state.attempts.push({ id: `PRIVATE_ATTEMPT_${task.id}`, jobId: job.id, taskId: task.id, profileId,
      status: task.status, startedAt: '2026-11-08T07:00:00Z', finishedAt: '2026-11-08T08:00:00Z', error: task.error });
    return { task, evaluation };
  }
  return { state, manifest, save };
}

test('audit counts exact-cohort consensus, valid abstentions and errors separately without leaking data or mutating state', () => {
  const { state, manifest, save } = fixture();
  for (const profile of ['gemma-local', 'clef-local']) {
    save(0, profile, { [FLAG]: 1, [NORMAL]: 1, [POSITIVE]: 1 });
    save(1, profile, { [FLAG]: null, [NORMAL]: null, [POSITIVE]: null });
  }
  save(2, 'gemma-local', {}, { code: 'INVALID_AI_RESULT', message: 'PRIVATE_ERROR', rules: ['missing_evidence', 'PRIVATE_RULE'] });
  save(2, 'clef-local', {}, { code: 'PRIVATE_CODE', message: 'PRIVATE_ERROR' });
  // Old answers and retries must not inflate this cohort's votes/results.
  state.evaluations.push({ ...structuredClone(state.evaluations[0]), id: 'PRIVATE_OLD_RESULT', jobId: 'PRIVATE_OLD_JOB' });
  state.operationalRefs.push({ id: state.conversations[0].id, evaluationId: 'PRIVATE_OLD_RESULT' });
  state.attempts.push({ ...state.attempts[0], id: 'PRIVATE_RETRY', status: 'failed', error: { code: 'AI_TRANSIENT', message: 'PRIVATE_ERROR' } });
  // MySQL JSON may reorder keys; identity must not depend on object key order.
  const reordered = p => Object.fromEntries(Object.entries(p).reverse());
  state.jobs[0].modelProfiles = state.jobs[0].modelProfiles.map(reordered);
  state.tasks.forEach(t => { t.profile = reordered(t.profile); });
  const before = structuredClone(state), audit = localBatchAudit(state, manifest, CHECKED);
  assert.deepEqual(audit.newCohortCoverage, { total: 500, sourceMissing: 0, evaluated: 2, reviewPending: 0,
    partial: 1, notEvaluated: 497, sourceChanged: 0, withSavedResults: 3 });
  assert.deepEqual(audit.agreed, { critical: { flags: 1, conversations: 1 }, normal: { flags: 1, conversations: 1 },
    positive: { flags: 1, conversations: 1 }, conversations: 1, attentionConversations: 1 });
  const [gemma, clef] = audit.models;
  assert.equal(gemma.savedEvaluations, 3);
  assert.equal(gemma.attemptCount, 4);
  assert.equal(gemma.firstStartedAt, '2026-11-08T07:00:00.000Z');
  assert.equal(gemma.lastFinishedAt, '2026-11-08T08:00:00.000Z');
  assert.equal(gemma.finishedAt, null);
  assert.equal(gemma.elapsedSeconds, 7200);
  assert.deepEqual(gemma.taskErrors, { INVALID_AI_RESULT: 1 });
  assert.deepEqual(clef.taskErrors, { OTHER: 1 });
  assert.equal(gemma.aiResults.evaluated, 5);
  assert.equal(gemma.aiResults.abstained, 3);
  assert.equal(gemma.aiResults.technicalErrors, 1);
  assert.deepEqual(gemma.aiResults.topValidationRules, [{ key: 'missing_evidence', count: 1 }, { key: 'OTHER', count: 1 }]);
  assert.equal(JSON.stringify(audit).includes('PRIVATE'), false);
  assert.deepEqual(state, before);
});

test('audit suppresses changed-source agreement, handles missing source and invalid timestamps without fabricating dates', () => {
  const { state, manifest, save } = fixture();
  save(0, 'gemma-local', { [FLAG]: 1 }); save(0, 'clef-local', { [FLAG]: 1 });
  state.conversations[0].messages[0].text += ' CHANGED';
  state.conversations.pop();
  state.attempts[0].startedAt = 'not a date'; state.attempts[0].finishedAt = 'not a date';
  const audit = localBatchAudit(state, manifest, CHECKED);
  assert.equal(audit.newCohortCoverage.sourceChanged, 1);
  assert.equal(audit.newCohortCoverage.sourceMissing, 1);
  assert.equal(audit.agreed.critical.flags, 0);
  assert.equal(audit.models[0].firstStartedAt, null);
  assert.equal(audit.models[0].lastFinishedAt, null);
  assert.equal(audit.models[0].elapsedSeconds, null);
  assert.equal(audit.models[0].invalidAttemptTimestamps, 1);
});

test('audit rejects duplicate/out-of-scope tasks and unrelated stored results, and reports an unstarted cohort as pending', () => {
  for (const mutate of [f => { f.state.tasks[0].conversationId = 'PRIVATE_OTHER'; },
    f => { f.state.tasks[0] = structuredClone(f.state.tasks[1]); },
    f => { f.state.jobs[0].modelProfiles = [f.manifest.profiles[0], f.manifest.profiles[0]]; }]) {
    const f = fixture(); mutate(f);
    assert.throws(() => localBatchAudit(f.state, f.manifest, CHECKED), error => error.code === 'AUDIT_SCOPE_MISMATCH');
  }
  const f = fixture();
  f.save(0, 'gemma-local').evaluation.jobId = 'PRIVATE_OTHER_JOB';
  assert.throws(() => localBatchAudit(f.state, f.manifest, CHECKED), error => error.code === 'AUDIT_RESULT_MISMATCH');
  const g = fixture(); g.state.jobs = []; g.state.tasks = [];
  const audit = localBatchAudit(g.state, g.manifest, CHECKED);
  assert.equal(audit.newCohortCoverage.notEvaluated, 500);
  assert.equal(audit.models.every(m => m.pending === 500 && m.savedEvaluations === 0), true);
});

test('the reusable audit accepts any dual batch size and keeps unavailable answers separate from valid abstentions', () => {
  const { state, manifest, save } = fixture();
  const { evaluation } = save(0, 'gemma-local', { [FLAG]: null, [NORMAL]: null });
  evaluation.results.find(result => result.variableId === FLAG).unavailabilityCode = 'UNAVAILABLE_IN_ADAPTER';
  const job = state.jobs[0];
  job.conversationIds = state.conversations.slice(0, 2).map(conversation => conversation.id);
  state.tasks = state.tasks.filter(task => job.conversationIds.includes(task.conversationId));
  const audit = evaluationBatchAudit(state, { jobId: job.id, conversationIds: job.conversationIds, profiles: manifest.profiles }, CHECKED);
  assert.equal(audit.coverage.total, 2);
  assert.equal(audit.coverage.withSavedResults, 1);
  assert.equal(audit.coverage.reviewPending, 1);
  assert.equal(audit.coverage.notEvaluated, 1);
  assert.equal(audit.models[0].total, 2);
  assert.equal(audit.models[0].pending, 1);
  assert.equal(audit.models[0].aiResults.abstained, 1);
  assert.equal(audit.models[0].aiResults.unavailable, 1);
  assert.equal(audit.models[1].pending, 2);
  assert.equal(JSON.stringify(audit).includes('PRIVATE'), false);
});

test('CLI inspection reads only the selected saved batch and never writes, runs models, or loads configuration on import', async () => {
  const { state } = fixture(), job = state.jobs[0];
  const previousId = job.id;
  job.id = '11111111-2222-4333-8444-555555555555';
  job.conversationIds = job.conversationIds.slice(0, 2);
  state.tasks = state.tasks.filter(task => job.conversationIds.includes(task.conversationId));
  state.tasks.forEach(task => { if (task.jobId === previousId) task.jobId = job.id; });
  const before = structuredClone(state), calls = [];
  const store = { async read() { calls.push('read'); return state; },
    async readWithConversations(options) { calls.push(options); return state; },
    transaction() { throw new Error('No writes allowed'); } };
  const audit = await inspectEvaluationBatch(store, job.id, CHECKED);
  assert.deepEqual(calls, ['read', { fresh: true, conversationIds: job.conversationIds }]);
  assert.equal(audit.readOnly, true);
  assert.equal(audit.coverage.total, 2);
  assert.equal(audit.models.every(model => model.pending === 2 && model.attemptCount === 0), true);
  assert.deepEqual(state, before);
  assert.equal(JSON.stringify(audit).includes('PRIVATE'), false);
  assert.equal(parseArguments(['--job-id', job.id]), job.id);
  for (const args of [[], ['--start'], ['--job-id', 'PRIVATE'], ['--job-id', job.id, '--resume']]) {
    assert.throws(() => parseArguments(args), error => error.code === 'INVALID_ARGUMENTS');
  }
  const script = fileURLToPath(new URL('../scripts/inspect-evaluation-batch.js', import.meta.url));
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../scripts/inspect-evaluation-batch.js', import.meta.url).href)})`], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout + imported.stderr, '');
  const invalid = spawnSync(process.execPath, [script, '--resume'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.equal(JSON.parse(invalid.stderr).errorCode, 'INVALID_ARGUMENTS');
});

test('CLI refuses missing or changing scope and sanitizes every failure', async () => {
  const { state } = fixture(), job = state.jobs[0];
  job.id = '11111111-2222-4333-8444-555555555555';
  let sourceRead = false;
  await assert.rejects(inspectEvaluationBatch({ read: async () => ({ jobs: [] }),
    readWithConversations() { sourceRead = true; } }, job.id), error => error.code === 'AUDIT_JOB_NOT_FOUND');
  assert.equal(sourceRead, false);
  const initial = structuredClone(state);
  state.jobs[0].conversationIds.pop();
  await assert.rejects(inspectEvaluationBatch({ read: async () => initial, readWithConversations: async () => state }, job.id, CHECKED),
    error => error.code === 'AUDIT_SCOPE_MISMATCH');
  assert.deepEqual(safeAuditFailure({ code: 'PRIVATE_CODE', message: 'PRIVATE_REASON', response: 'PRIVATE_CONTENT' }), {
    success: false, readOnly: true, errorCode: 'AUDIT_FAILED', message: 'No se pudo obtener el diagnóstico agregado. No se modificaron datos.' });
  const { state: duplicate, manifest, save } = fixture();
  const { evaluation } = save(0, 'gemma-local');
  duplicate.evaluations.push(structuredClone(evaluation));
  assert.throws(() => localBatchAudit(duplicate, manifest, CHECKED), error => error.code === 'AUDIT_RESULT_MISMATCH');
});
