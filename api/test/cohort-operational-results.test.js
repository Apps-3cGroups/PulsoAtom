import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogV5 } from '../src/catalog-v5.js';
import { catalogReferences, digest, evaluationContext } from '../src/evaluation-context.js';
import { operationalEvaluation, operationalConsensus } from '../src/operational-evaluation.js';
import { conversationView } from '../src/domain.js';

const FLAG = 'cliente_amenazo_cancelar_pedido';
const POSITIVE = 'cliente_felicito_al_asistente';
const CODE = 'primera_respuesta_humano_mayor_5_min';
const DESCRIPTOR = 'tipo_interaccion';
function fixture() {
  const catalog = catalogV5.filter(v => [FLAG, POSITIVE, CODE, DESCRIPTOR, 'num_mensajes_cliente'].includes(v.id))
    .map(v => ({ ...structuredClone(v), active: true }));
  const conversation = { id: 'synthetic-conversation', country: 'HN', date: '2026-11-05', completed: true,
    startedAt: '2026-11-05T15:00:00Z', endedAt: '2026-11-05T15:01:00Z',
    client: { name: 'Cliente sintético' }, agent: { id: 'synthetic-agent', name: 'Asesor sintético' }, media: [], topics: [],
    messages: [{ id: 'm1', actor: 'cliente', text: 'Cancelo el pedido si no llega.', timestamp: '2026-11-05T15:00:00Z' },
      { id: 'm2', actor: 'cliente', text: 'Mi pedido será cancelado.', timestamp: '2026-11-05T15:01:00Z' }] };
  const context = evaluationContext(conversation, catalog), refs = catalogReferences(catalog);
  const profiles = ['gemma-local', 'clef-local'].map((id, i) => ({ id, label: i ? 'Clef' : 'Gemma', provider: 'gateway',
    model: i ? 'clef-flash' : 'gemma-synthetic', protocol: 'chat', configurationHash: digest({ id }) }));
  const originalJob = { id: 'gemma-job', purpose: 'operational', mode: 'single', maintenanceId: 'synthetic-maintenance',
    modelProfiles: [profiles[0]], conversationIds: [conversation.id], catalogVersions: refs };
  const job = { id: 'clef-job', purpose: 'comparison', mode: 'single', maintenanceId: originalJob.maintenanceId,
    cohortId: `clef-complement-${originalJob.maintenanceId}`, cohortManifestHash: digest({ synthetic: 'manifest' }),
    modelProfiles: structuredClone(profiles), conversationIds: [conversation.id], catalogVersions: structuredClone(refs) };
  const evaluations = profiles.map((profile, i) => ({ id: `evaluation-${i}`, jobId: i ? job.id : originalJob.id,
    taskId: `original-task-${i}`, purpose: i ? 'comparison' : 'operational', conversationId: conversation.id,
    profileId: profile.id, requestedProfileId: profile.id, provider: profile.provider, model: profile.model,
    modelConfiguration: structuredClone(profile), usedFallback: false, partial: false, ...context,
    catalogVersions: structuredClone(refs), createdAt: `2026-11-0${i + 6}T15:00:00Z`,
    results: catalog.map(v => ({ variableId: v.id, type: v.type, method: v.method,
      status: v.id === CODE ? 'no_evaluado' : 'evaluado', value: v.id === CODE ? null : v.id === DESCRIPTOR ? 'pedido' : v.id === POSITIVE ? 0 : 1,
      reason: `${profile.label}: resultado sintético`, evidence: v.id === FLAG ? [{ messageId: `m${i + 1}`, quote: conversation.messages[i].text }] : [],
      ...(['Código', 'Cálculo'].includes(v.method) ? { codeRule: 'synthetic-shared-code' } : {}),
      ...(v.id === CODE ? { unavailableReason: 'BUSINESS_HOURS_NOT_CONFIGURED' } : {}) })) }));
  const originalTask = { id: evaluations[0].taskId, jobId: originalJob.id, conversationId: conversation.id,
    profile: structuredClone(profiles[0]), status: 'completed', evaluationId: evaluations[0].id, context: structuredClone(context) };
  const reused = { ...structuredClone(originalTask), id: 'reused-gemma-task', jobId: job.id,
    reusedEvaluationId: evaluations[0].id, reusedJobId: originalJob.id, reusedTaskId: originalTask.id };
  const clefTask = { id: evaluations[1].taskId, jobId: job.id, conversationId: conversation.id,
    profile: structuredClone(profiles[1]), status: 'completed', evaluationId: evaluations[1].id, context: structuredClone(context) };
  const sample = { id: job.id, jobId: job.id, cohortId: job.cohortId, modelProfiles: structuredClone(profiles),
    catalogVersions: structuredClone(refs), cases: [{ conversationId: conversation.id, ...context }] };
  const state = { catalog, catalogVersions: catalog.map(v => ({ id: `${v.id}:${v.version}`, itemId: v.id, version: v.version, snapshot: v })),
    conversations: [conversation], evaluations, operationalRefs: [{ id: conversation.id, evaluationId: evaluations[0].id }],
    jobs: [originalJob, job], tasks: [originalTask, reused, clefTask], comparisons: [sample], reviews: [], verdicts: [] };
  return { state, conversation, anchor: evaluations[0], clef: evaluations[1], originalJob, originalTask, reused, clefTask, job, sample };
}
const resultFor = (evaluation, id = FLAG) => evaluation.results.find(r => r.variableId === id);

test('only the explicit complement supplies two saved model answers and preserves the Gemma anchor', () => {
  const f = fixture(), before = structuredClone(f.state);
  const result = operationalEvaluation(f.state, f.anchor);
  assert.equal(result.id, f.anchor.id);
  assert.equal(result.dual, true);
  assert.equal(resultFor(result).comparison.agreement, 'agree-positive');
  assert.deepEqual(resultFor(result).comparison.cells.map(c => [c.label, c.result.reason, c.result.evidence[0].messageId]),
    [['Gemma', 'Gemma: resultado sintético', 'm1'], ['Clef', 'Clef: resultado sintético', 'm2']]);
  assert.equal(operationalConsensus(result, FLAG).detected, true);
  assert.equal(resultFor(result).comparison.commonEvidence, false);
  assert.deepEqual(result.modelReviews.map(r => [r.profileId, r.status, r.totalVariables, r.evaluatedCount, r.provenance]),
    [['gemma-local', 'completed', 3, 3, 'operational'], ['clef-local', 'completed', 3, 3, 'cohort-complement']]);
  assert.equal(result.modelReviewPending, false);
  assert.equal(resultFor(result, CODE).comparison.codeOnly, true);
  assert.equal(operationalConsensus(result, CODE), undefined);
  assert.deepEqual(f.state, before);
});

test('agreement, disagreement and common evidence remain distinct without extra votes', () => {
  const f = fixture();
  Object.assign(resultFor(f.clef), { value: 0, evidence: [] });
  let result = operationalEvaluation(f.state, f.anchor);
  assert.equal(resultFor(result).comparison.agreement, 'disagree');
  assert.equal(resultFor(result).comparison.votes, 2);
  assert.equal(operationalConsensus(result, FLAG).detected, false);
  Object.assign(resultFor(f.anchor), { value: 0, evidence: [] });
  result = operationalEvaluation(f.state, f.anchor);
  assert.equal(resultFor(result).comparison.agreement, 'agree-negative');
  for (const e of [f.anchor, f.clef]) Object.assign(resultFor(e), { value: 1, evidence: [{ messageId: 'm1', quote: 'Evidencia sintética común' }] });
  result = operationalEvaluation(f.state, f.anchor);
  assert.equal(resultFor(result).comparison.detections, 2);
  assert.equal(resultFor(result).comparison.commonEvidence, true);
});

test('valid abstentions and unavailable shared calculations are completed responses, not pending work', () => {
  const f = fixture();
  for (const e of [f.anchor, f.clef]) for (const r of e.results.filter(r => ['IA', 'IA + código'].includes(r.method))) {
    Object.assign(r, { status: 'no_evaluado', value: null, evidence: [] });
  }
  const result = operationalEvaluation(f.state, f.anchor);
  assert.ok(result.modelReviews.every(r => r.status === 'completed' && r.abstainedCount === 3 && r.evaluatedCount === 0 && r.errorCount === 0));
  assert.equal(result.modelReviewPending, false);
  assert.equal(resultFor(result).comparison.votes, 0);
  assert.equal(operationalConsensus(result, FLAG).detected, false);
});

test('queued, running, missing, failed and partial Clef responses remain distinct and preserve valid results', () => {
  for (const status of ['pending', 'running', 'failed', 'missing', 'partial']) {
    const f = fixture();
    if (status === 'missing') f.state.tasks = f.state.tasks.filter(t => t !== f.clefTask);
    else f.clefTask.status = status;
    if (status !== 'partial') f.clefTask.evaluationId = null;
    else {
      f.clef.partial = true;
      Object.assign(resultFor(f.clef, POSITIVE), { status: 'no_evaluado', value: null,
        error: { code: 'INVALID_AI_RESULT', message: 'PRIVATE_RAW_ERROR', details: 'PRIVATE_CREDENTIAL' } });
    }
    f.clefTask.error = { code: 'AI_TRANSIENT', message: 'PRIVATE_RAW_ERROR' };
    const result = operationalEvaluation(f.state, f.anchor), review = result.modelReviews.find(r => r.profileId === 'clef-local');
    assert.equal(result.dual, true, status);
    assert.equal(review.status, status === 'missing' ? 'pending' : status);
    assert.equal(result.modelReviewPending, ['pending', 'running', 'missing'].includes(status));
    assert.equal(operationalConsensus(result, FLAG).detected, status === 'partial');
    assert.equal(JSON.stringify(result).includes('PRIVATE_RAW_ERROR'), false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_CREDENTIAL'), false);
    if (status === 'partial') assert.equal(review.errorCount, 1);
  }
});

test('ambiguous or unrelated stored comparisons never publish consensus', () => {
  const mutations = [
    f => { f.job.cohortId = 'other-cohort'; },
    f => { delete f.job.cohortManifestHash; },
    f => { f.job.cohortManifestHash = 'not-a-hash'; },
    f => { f.job.maintenanceId = 'other-maintenance'; },
    f => { f.job.purpose = 'operational'; },
    f => { f.state.jobs.push(structuredClone(f.job)); },
    f => { f.state.jobs.push(structuredClone(f.originalJob)); },
    f => { f.state.comparisons.push(structuredClone(f.sample)); },
    f => { f.sample.cases.push(structuredClone(f.sample.cases[0])); },
    f => { f.sample.cohortId = 'other-cohort'; },
    f => { f.sample.jobId = 'other-job'; },
    f => { f.state.tasks.push(structuredClone(f.reused)); },
    f => { f.state.tasks.push(structuredClone(f.clefTask)); },
    f => { f.state.evaluations.push(structuredClone(f.clef)); },
    f => { f.state.evaluations.push(structuredClone(f.anchor)); },
    ...['reusedEvaluationId', 'reusedTaskId', 'reusedJobId'].map(key => f => { f.reused[key] = 'unrelated'; }),
    f => { f.clefTask.reusedEvaluationId = f.anchor.id; },
    f => { f.clef.taskId = f.originalTask.id; },
    f => { f.clef.jobId = f.originalJob.id; },
    f => { f.clef.conversationId = 'other-conversation'; },
    f => { f.clef.results.push(structuredClone(f.clef.results[0])); },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const f = fixture(); mutate(f);
    const result = operationalEvaluation(f.state, f.anchor);
    assert.equal(result.dual, undefined, `mutation ${i}`);
    assert.equal(operationalConsensus(result, FLAG), undefined, `mutation ${i}`);
    assert.equal(result.modelReviews.length, 1, `mutation ${i}`);
  }
});

test('content, version, configuration and effective model identity must match the frozen cohort', () => {
  const mutations = [
    ...['sourceHash', 'catalogHash', 'promptHash', 'promptVersion', 'rulesVersion'].map(key => f => { f.clef[key] = 'different'; }),
    f => { f.sample.cases[0].sourceHash = 'different'; },
    f => { f.clefTask.context.sourceHash = 'different'; },
    f => { f.reused.context.catalogHash = 'different'; },
    f => { f.clef.catalogVersions[0].version++; },
    f => { f.clef.catalogVersions[0].active = false; },
    f => { f.sample.catalogVersions[0].version++; },
    f => { f.job.catalogVersions[0].active = false; },
    f => { f.clef.modelConfiguration.configurationHash = digest('different'); },
    f => { f.sample.modelProfiles[1].configurationHash = digest('different'); },
    f => { f.clefTask.profile.configurationHash = digest('different'); },
    f => { f.clef.model = f.anchor.model; },
    f => { f.job.modelProfiles[1].model = f.job.modelProfiles[0].model; },
    f => { f.clef.provider = ''; },
    f => { f.clef.profileId = 'other-profile'; },
    f => { f.clef.requestedProfileId = 'other-profile'; },
    f => { f.clef.usedFallback = true; },
    f => { f.clef.protocol = 'systemone'; },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const f = fixture(); mutate(f);
    const result = operationalEvaluation(f.state, f.anchor);
    assert.equal(result.dual, undefined, `mutation ${i}`);
    assert.equal(operationalConsensus(result, FLAG), undefined, `mutation ${i}`);
  }
});

test('changed Atom content retains both historical answers but cannot publish an automatic flag', () => {
  const f = fixture();
  f.conversation.messages[0].text += ' Mensaje modificado después de la evaluación.';
  const result = operationalEvaluation(f.state, f.anchor);
  assert.equal(result.modelReviews.length, 2);
  assert.equal(resultFor(result).comparison.sourceChanged, true);
  assert.equal(resultFor(result).comparison.cells.filter(c => c.result).length, 2);
  assert.equal(operationalConsensus(result, FLAG).detected, false);
  const detail = conversationView(f.state, f.conversation, undefined, true);
  assert.equal(detail.sourceChanged, true);
  assert.equal(detail.marks.length, 0);
});

test('existing reviews remain linked to the original Gemma evaluation', () => {
  const f = fixture();
  f.state.reviews.push({ id: 'synthetic-review', conversationId: f.conversation.id, evaluationId: f.anchor.id,
    variableId: FLAG, action: 'refutar', comment: 'Revisión humana sintética', authorName: 'Supervisor' });
  const before = structuredClone(f.state);
  const detail = conversationView(f.state, f.conversation, undefined, true);
  assert.equal(detail.evaluation.id, f.anchor.id);
  assert.equal(detail.variables.find(v => v.id === FLAG).kind, 'refuted');
  assert.equal(detail.refuted, 1);
  assert.deepEqual(f.state, before);
});
