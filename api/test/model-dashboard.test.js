import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelDashboard } from '../src/model-dashboard.js';
import { digest, sourceFingerprint } from '../src/evaluation-context.js';

const profiles = [{ id: 'gpt', viewId: 'gpt@a', configurationHash: 'a', label: 'GPT', model: 'gpt-model', provider: 'openai' },
  { id: 'gemini', viewId: 'gemini@b', configurationHash: 'b', label: 'Gemini', model: 'gemini-model', provider: 'gemini' }];
const registry = { list: () => profiles };
function fixture() {
  const variables = ['f1', 'f2', 'f3'].map(id => ({ id, name: id, version: 1, active: true, type: 'Flag', method: 'IA' }));
  variables.push({ id: 'code', name: 'code', version: 1, active: true, type: 'Flag', method: 'Código' });
  const catalogVersions = variables.map(snapshot => ({ itemId: snapshot.id, version: 1, snapshot }));
  const state = { metadata: {}, conversations: [], jobs: [], tasks: [], evaluations: [], verdicts: [], catalogVersions, catalog: [] };
  const refs = variables.map(v => ({ id: v.id, version: 1, active: true }));
  state.jobs.push({ id: 'job', purpose: 'operational', createdAt: '2026-11-09T06:30:00Z', modelProfiles: profiles, catalogVersions: refs, status: 'completed' });
  for (let c = 0; c < 2; c++) {
    const conversation = { id: `c${c}`, country: c ? 'GT' : 'HN', messages: [{ id: `m${c}`, actor: 'client', text: 'Test' }] };
    state.conversations.push(conversation);
    const context = { sourceHash: sourceFingerprint(conversation), catalogHash: 'catalog', promptHash: 'prompt', rulesVersion: 'rules' };
    profiles.forEach((profile, i) => {
      const id = `${conversation.id}:${profile.id}`;
      state.tasks.push({ id, jobId: 'job', conversationId: conversation.id, profile, context, status: 'completed', evaluationId: id });
      state.evaluations.push({ id, taskId: id, conversationId: conversation.id, jobId: 'job', purpose: 'operational',
        profileId: profile.id, requestedProfileId: profile.id, provider: profile.provider, model: profile.model, catalogVersions: structuredClone(refs),
        modelConfiguration: profile, ...context, durationMs: (c + 1) * (i ? 2000 : 1000),
        results: variables.map(v => ({ variableId: v.id, status: 'evaluado', value: i ? 0 : 1 })) });
    });
  }
  return state;
}
test('prioriza los perfiles reales Clef y Gemma sin renombrar resultados de otros modelos', () => {
  const state = fixture();
  const local = [{ id: 'clef-local', label: 'Clef', model: 'clef-flash', provider: 'gateway', configurationHash: 'clef-config' },
    { id: 'gemma-local', label: 'Gemma', model: 'gemma-4-26b-a4b-it-mlx', provider: 'gateway', configurationHash: 'gemma-config' }];
  state.jobs[0].modelProfiles = [...local].reverse();
  state.jobs.push({ ...state.jobs[0], id: 'legacy-job', createdAt: '2026-11-10T06:30:00Z', modelProfiles: profiles });
  state.tasks.forEach((task, index) => { task.profile = local[index % 2]; });
  state.evaluations.forEach((evaluation, index) => {
    const p = local[index % 2];
    Object.assign(evaluation, { profileId: p.id, requestedProfileId: p.id, provider: p.provider, model: p.model, modelConfiguration: p });
  });
  const result = modelDashboard(state, registry);
  assert.deepEqual(result.metrics.map(m => [m.profileId, m.label, m.model, m.answered]), [
    ['clef-local', 'Clef', 'clef-flash', 6], ['gemma-local', 'Gemma', 'gemma-4-26b-a4b-it-mlx', 6],
  ]);
  assert.equal(result.profiles.find(p => p.profileId === 'gpt').label, 'GPT');
  assert.equal(result.cohort.conversations, 2);
});
test('cohorte idéntica, tiempos por conversación y cobertura con denominador histórico sin código', () => {
  const state = fixture();
  const result = modelDashboard(state, registry);
  assert.equal(result.cohort.conversations, 2);
  assert.equal(result.cohort.flagsMin, 3);
  assert.equal(result.cohort.timed, 2);
  assert.deepEqual(result.metrics.map(m => [m.total, m.answered, m.coverage]), [[6, 6, 1], [6, 6, 1]]);
  assert.deepEqual(result.metrics.map(m => [m.averageMs, m.minMs, m.maxMs, m.medianMs, m.p95Ms]), [[1500, 1000, 2000, 1500, 2000], [3000, 2000, 4000, 3000, 4000]]);
  assert.equal(result.metrics[0].fastest.conversationId, 'c0');
  assert.equal(result.cohort.agreementRate, 0);
  assert.equal(result.metrics[0].accuracy, null);
  assert.equal(result.flags, undefined);
});
test('respuestas parciales, abstenciones y errores no desaparecen del denominador', () => {
  const state = fixture();
  state.evaluations[0].results[0] = { variableId: 'f1', status: 'no_evaluado', value: null };
  state.evaluations[0].results[1].error = { code: 'INVALID' };
  state.tasks[0].status = 'partial';
  state.tasks[3].status = 'failed'; state.tasks[3].evaluationId = null;
  const { metrics, cohort } = modelDashboard(state, registry);
  assert.equal(metrics[0].answered, 4); assert.equal(metrics[0].total, 6);
  assert.equal(metrics[0].abstained, 1); assert.equal(metrics[0].failedFlags, 1);
  assert.equal(metrics[1].pending, 3); assert.equal(metrics[1].completionRate, .5);
  assert.equal(cohort.timed, 1); assert.equal(metrics[0].averageMs, 1000); assert.equal(metrics[1].averageMs, 2000);
});
test('duraciones ausentes se muestran sin datos y cero es una medición válida', () => {
  const state = fixture();
  state.evaluations.forEach(e => { e.durationMs = null; });
  let result = modelDashboard(state, registry);
  assert.equal(result.cohort.timed, 0); assert.equal(result.metrics[0].averageMs, null); assert.equal(result.metrics[1].maxMs, null);
  state.evaluations[0].durationMs = 0; state.evaluations[1].durationMs = 0;
  result = modelDashboard(state, registry); assert.equal(result.cohort.timed, 1); assert.equal(result.metrics[0].minMs, 0);
});
test('la última ejecución comparable evita duplicados; no cuenta muestras de laboratorio', () => {
  const state = fixture();
  state.jobs.push({ ...state.jobs[0], id: 'new', createdAt: '2026-11-09T09:00:00Z' }, { ...state.jobs[0], id: 'sample', purpose: 'comparison', createdAt: '2026-11-10T00:00:00Z' });
  for (const jobId of ['new', 'sample']) for (const task of state.tasks.slice(0, 2)) state.tasks.push({ ...task, id: `${jobId}-${task.id}`, jobId, evaluationId: null, status: 'pending' });
  const result = modelDashboard(state, registry);
  assert.equal(result.cohort.conversations, 2); assert.equal(result.metrics[0].answered, 3);
  assert.equal(result.metrics[0].inProgress, 1); assert.equal(result.jobs.length, 2);
});
test('filtros por fecha local, país y ejecución son inclusivos y no mutan estado', () => {
  const state = fixture(), before = structuredClone(state);
  assert.equal(modelDashboard(state, registry, { from: '2026-11-09', to: '2026-11-09', country: 'HN', jobId: 'job' }).cohort.conversations, 1);
  state.jobs[0].createdAt = '2026-11-09T05:59:59Z';
  assert.equal(modelDashboard(state, registry, { from: '2026-11-09' }).cohort.conversations, 0);
  state.jobs[0].createdAt = before.jobs[0].createdAt;
  assert.deepEqual(state, before);
});
test('no inventa contextos ni versiones de checklist; no atribuye respaldos a otro modelo', () => {
  const state = fixture();
  state.tasks[1].context = { ...state.tasks[1].context, sourceHash: 'different' };
  let result = modelDashboard(state, registry);
  assert.equal(result.cohort.conversations, 1); assert.equal(result.cohort.excluded, 1);
  state.evaluations[2].usedFallback = true;
  result = modelDashboard(state, registry);
  assert.equal(result.metrics[0].answered, 0); assert.equal(result.metrics[0].fallback, 1); assert.equal(result.cohort.timed, 0);
  state.catalogVersions = [];
  result = modelDashboard(state, registry); assert.equal(result.cohort.conversations, 0);
});
test('exactitud solo usa dictámenes a ciegas compatibles, vigentes y respuesta de ambos', () => {
  const state = fixture();
  const base = { conversationId: 'c0', sourceHash: state.tasks[0].context.sourceHash, catalogVersion: 1, mode: 'blind', outcome: 'present' };
  state.verdicts.push({ ...base, variableId: 'f1' }, { ...base, variableId: 'f2', outcome: 'absent' }, { ...base, variableId: 'f3', mode: 'assisted' });
  let result = modelDashboard(state, registry);
  assert.deepEqual(result.metrics.map(m => [m.validated, m.accuracy]), [[2, .5], [2, .5]]);
  assert.equal(result.metrics[0].fp, 1); assert.equal(result.metrics[1].fn, 1);
  state.evaluations[1].results[1].status = 'no_evaluado';
  result = modelDashboard(state, registry); assert.equal(result.metrics[0].validated, 1); assert.equal(result.metrics[0].accuracy, 1); assert.equal(result.metrics[1].accuracy, 0);
  state.conversations[0].messages[0].text = 'Changed';
  result = modelDashboard(state, registry); assert.equal(result.metrics[0].accuracy, null);
});
test('reglas compartidas no suman respuestas ni votos de IA y alias efectivos duplicados no acuerdan', () => {
  const state = fixture();
  state.evaluations[0].results[0].codeRule = true;
  state.evaluations[1].results[0].codeRule = true;
  state.evaluations[0].results[1] = { variableId: 'f2', codeRule: true, status: 'evaluado', value: 1, aiResult: { status: 'no_evaluado', value: null } };
  const result = modelDashboard(state, registry);
  assert.equal(result.metrics[0].answered, 4); assert.equal(result.metrics[0].abstained, 1);
  assert.equal(result.cohort.jointAnswered, 4);
});
test('modelos inválidos, duplicados y ejecuciones ajenas se rechazan; histórico vacío es explícito', () => {
  const state = fixture();
  assert.throws(() => modelDashboard(state, registry, { left: 'unknown' }), { code: 'INVALID_MODEL' });
  assert.throws(() => modelDashboard(state, registry, { left: 'gpt@a', right: 'gpt@a' }), { code: 'DUPLICATE_MODEL' });
  assert.throws(() => modelDashboard(state, registry, { jobId: 'unknown' }), { code: 'INVALID_JOB' });
  const result = modelDashboard({ metadata: {}, tasks: [{ id: 'interrupted', status: 'interrupted' }] }, registry);
  assert.equal(result.cohort.conversations, 0); assert.equal(result.metrics[0].coverage, null);
});

test('agregados individualizables conservan contexto de exposición para futuras validaciones', () => {
  const state = fixture();
  assert.deepEqual(modelDashboard(state, registry).exposureContexts, []);
  const narrowed = modelDashboard(state, registry, { country: 'HN' });
  assert.equal(narrowed.exposureContexts.length, 1);
  assert.equal(narrowed.exposureContexts[0].conversationId, 'c0');
  assert.equal(narrowed.exposureContexts[0].sourceHash, state.tasks[0].context.sourceHash);
});

test('abstenciones válidas finalizan el trabajo; límites del adaptador no son abstenciones del modelo', () => {
  const state = fixture();
  for (const evaluation of state.evaluations) for (const r of evaluation.results) Object.assign(r, { status: 'no_evaluado', value: null });
  state.evaluations[0].results[0].unavailabilityCode = 'evidence_capacity_exceeded';
  const { metrics, cohort } = modelDashboard(state, registry);
  assert.deepEqual(metrics.map(m => [m.completed, m.partial, m.completionRate, m.answered]), [[2, 0, 1, 0], [2, 0, 1, 0]]);
  assert.equal(metrics[0].abstained, 5);
  assert.equal(metrics[0].unavailable, 1);
  assert.equal(metrics[0].failedFlags, 0);
  assert.equal(cohort.jointAnswered, 0);
  assert.equal(cohort.agreementRate, null);
});

test('una respuesta debe pertenecer a la tarea, ejecución, contenido, modelo y versión exactos', () => {
  for (const mutate of [
    e => { e.jobId = 'unrelated-job'; }, e => { e.taskId = 'unrelated-task'; },
    e => { e.conversationId = 'unrelated-conversation'; }, e => { e.model = 'unrequested-model'; },
    e => { e.purpose = 'comparison'; }, e => { e.modelConfiguration.configurationHash = 'changed'; },
  ]) {
    const state = fixture();
    state.evaluations[0].modelConfiguration = structuredClone(state.evaluations[0].modelConfiguration);
    mutate(state.evaluations[0]);
    const result = modelDashboard(state, registry);
    assert.equal(result.metrics[0].answered, 3);
    assert.equal(result.cohort.timed, 1);
  }
  const state = fixture();
  state.evaluations[0].catalogVersions[0].version = 2;
  state.evaluations[1].catalogVersions[0].active = false;
  let result = modelDashboard(state, registry);
  assert.deepEqual(result.metrics.map(m => m.answered), [5, 5]);
  assert.equal(result.cohort.jointAnswered, 5);
  state.evaluations[0].results.push({ ...state.evaluations[0].results[1] });
  result = modelDashboard(state, registry);
  assert.equal(result.metrics[0].answered, 4);
});

test('las decisiones nativas exigen el contrato congelado, sin mezclar la configuración chat anterior', () => {
  const state = fixture();
  const native = { ...profiles[0], protocol: 'systemone', configurationHash: 'a'.repeat(64),
    adapterVersion: 'synthetic-v1', instructionsHash: 'b'.repeat(64) };
  state.jobs[0].modelProfiles = [native, profiles[1]];
  for (const task of state.tasks.filter(t => t.profile.id === native.id)) task.profile = structuredClone(native);
  for (const e of state.evaluations.filter(e => e.profileId === native.id)) Object.assign(e, {
    modelConfiguration: structuredClone(native), protocol: native.protocol, adapterVersion: native.adapterVersion, instructionsHash: native.instructionsHash,
  });
  let result = modelDashboard(state, registry);
  assert.equal(result.metrics[0].answered, 6);
  state.evaluations[0].instructionsHash = 'c'.repeat(64);
  result = modelDashboard(state, registry);
  assert.equal(result.metrics[0].answered, 3);
  assert.equal(result.cohort.jointAnswered, 3);
});

function complementFixture() {
  const state = fixture();
  state.conversations = state.conversations.slice(0, 1);
  state.tasks = state.tasks.slice(0, 2);
  state.evaluations = state.evaluations.slice(0, 2);
  const local = ['gemma-local', 'clef-local'].map(id => ({ id, label: id, provider: 'gateway', model: `${id}-synthetic`,
    protocol: 'chat', configurationHash: digest({ id }) }));
  const original = state.jobs[0];
  Object.assign(original, { mode: 'single', maintenanceId: 'synthetic-maintenance', modelProfiles: [local[0]], conversationIds: ['c0'] });
  const complement = { ...structuredClone(original), id: 'complement', createdAt: '2026-11-10T07:00:00Z',
    purpose: 'comparison', cohortId: `clef-complement-${original.maintenanceId}`, cohortManifestHash: digest('synthetic-manifest'), modelProfiles: local };
  state.jobs.push(complement);
  state.tasks.forEach((task, i) => {
    Object.assign(task, { jobId: i ? complement.id : original.id, profile: structuredClone(local[i]) });
    task.context.promptVersion = 'synthetic-v1';
    Object.assign(state.evaluations[i], { ...task.context, purpose: i ? 'comparison' : 'operational',
      jobId: task.jobId, profileId: local[i].id, requestedProfileId: local[i].id, provider: local[i].provider, model: local[i].model,
      modelConfiguration: structuredClone(local[i]), usedFallback: false });
  });
  const originalTask = state.tasks[0];
  state.tasks.push({ ...structuredClone(originalTask), id: 'reused-gemma-task', jobId: complement.id,
    reusedEvaluationId: originalTask.evaluationId, reusedTaskId: originalTask.id, reusedJobId: original.id });
  state.comparisons = [{ id: complement.id, jobId: complement.id, cohortId: complement.cohortId, modelProfiles: structuredClone(local),
    catalogVersions: structuredClone(complement.catalogVersions), cases: [{ conversationId: 'c0', ...originalTask.context }] }];
  return state;
}

test('incluye el complemento histórico Gemma/Clef con vínculo explícito sin duplicar la conversación', () => {
  const state = complementFixture(), before = structuredClone(state);
  const result = modelDashboard(state, registry, { jobId: 'complement' });
  assert.equal(result.cohort.conversations, 1);
  assert.deepEqual(result.metrics.map(m => [m.profileId, m.answered, m.completed]), [['clef-local', 3, 1], ['gemma-local', 3, 1]]);
  assert.equal(result.cohort.timed, 1);
  assert.equal(result.jobs.length, 1);
  assert.deepEqual(state, before);
  assert.equal(modelDashboard(state, registry, { from: '2026-11-10', to: '2026-11-10' }).cohort.conversations, 1);
  assert.equal(modelDashboard(state, registry, { from: '2026-11-11' }).cohort.conversations, 0);
  assert.equal(modelDashboard(state, registry).cohort.conversations, 1);
});

test('el protocolo chat implícito de las tareas históricas conserva su identidad comprobada', () => {
  const state = complementFixture();
  for (const task of state.tasks) delete task.profile.protocol;
  const result = modelDashboard(state, registry, { jobId: 'complement' });
  assert.equal(result.cohort.conversations, 1);
  assert.deepEqual(result.metrics.map(m => [m.answered, m.completed]), [[3, 1], [3, 1]]);
});

test('un complemento sin trazabilidad o una muestra genérica no aporta respuestas ni tiempos', () => {
  for (const mutate of [
    s => { delete s.jobs[1].cohortManifestHash; },
    s => { s.tasks[2].reusedTaskId = 'another-task'; },
    s => { s.evaluations[1].taskId = 'another-task'; },
    s => { s.comparisons[0].cases[0].sourceHash = 'different'; },
    s => { s.jobs[1].cohortId = 'generic-laboratory'; },
  ]) {
    const state = complementFixture(); mutate(state);
    const result = modelDashboard(state, registry);
    assert.equal(result.cohort.conversations, 0);
    assert.equal(result.cohort.timed, 0);
    assert.ok(result.metrics.every(m => m.answered === 0));
    assert.throws(() => modelDashboard(state, registry, { jobId: 'complement' }), { code: 'INVALID_JOB' });
  }
});
