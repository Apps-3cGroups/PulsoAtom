import { AppError } from './errors.js';
import { catalogReferences, digest, sourceFingerprint } from './evaluation-context.js';
import { runtimeConfiguration } from './automation-configuration.js';
import { startEvaluationBatch, resumeEvaluationBatch, evaluationModelProgress } from './evaluation-service.js';
import { applyReviewSelection } from './review-selection.js';

const fail = (code, message) => { throw new AppError(409, message, code); };
const slug = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const hash = /^[a-f0-9]{64}$/;
const countries = ['HN', 'PA', 'CR', 'SV', 'MX', 'NI'];
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryable = new Set(['AI_UNAVAILABLE', 'AI_TRANSIENT', 'INVALID_AI_RESULT', 'AI_INCOMPLETE', 'DATABASE_TRANSIENT', 'WORKER_INTERRUPTED', 'EVALUATION_FAILED']);

export function validateFreshReviewManifest(manifest, { authorize = false } = {}) {
  if (manifest?.schemaVersion !== 1 || !slug.test(manifest.id || '')
    || !date(manifest.scope?.from) || !date(manifest.scope?.to) || manifest.scope.from > manifest.scope.to
    || manifest.scope.timezone !== 'America/Tegucigalpa' || !Number.isFinite(Date.parse(manifest.reviewDeadline))
    || !same(manifest.profiles, ['clef-local', 'gemma-local']) || !Array.isArray(manifest.cases)
    || manifest.cases.length < 1 || manifest.cases.length > 500 || manifest.caseCount !== manifest.cases.length
    || manifest.expectedNewEvaluations !== manifest.caseCount * 2
    || new Set(manifest.cases.map(item => item.conversationId)).size !== manifest.cases.length
    || digest({ scope: manifest.scope, cases: manifest.cases }) !== manifest.selectionHash) {
    fail('INVALID_REVIEW_REQUEST', 'La solicitud de evaluación nueva está incompleta o cambió.');
  }
  const counts = Object.fromEntries(countries.map(code => [code, 0]));
  for (const item of manifest.cases) {
    if (typeof item.conversationId !== 'string' || !item.conversationId || item.conversationId.length > 200
      || !countries.includes(item.country) || !date(item.activityDate) || item.activityDate < manifest.scope.from || item.activityDate > manifest.scope.to
      || !Number.isFinite(Date.parse(item.activityAt)) || !hash.test(item.currentSourceHash || '')
      || !item.sourceDocumentId || !hash.test(item.sourceDocumentHash || '') || !Number.isInteger(item.messageCount) || item.messageCount < 1
      || ['evaluationId', 'jobId', 'taskId', 'models', 'publishedAnchorEvaluationId', 'selectionAnchorEvaluationId'].some(key => key in item)) {
      fail('INVALID_REVIEW_REQUEST', 'La muestra debe contener fuentes actuales, sin resultados reutilizados.');
    }
    counts[item.country] += 1;
  }
  if (countries.some(code => counts[code] !== (manifest.counts?.[code] || 0))) fail('INVALID_REVIEW_REQUEST', 'Los cupos no coinciden con los miembros de la muestra.');
  if (authorize && (manifest.authorizedForExecution !== true || manifest.preparatoryOnly !== false)) fail('REVIEW_REQUEST_NOT_AUTHORIZED', 'La solicitud sigue en preparación y no autoriza inferencias ni publicación.');
  return manifest;
}

export function assertFreshReviewSources(manifest, conversations, ids = manifest.cases.map(item => item.conversationId)) {
  const expected = new Map(manifest.cases.map(item => [item.conversationId, item]));
  if (new Set(ids).size !== ids.length || ids.some(id => !expected.has(id)) || conversations.length !== ids.length
    || new Set(conversations.map(item => item.id)).size !== ids.length) fail('REVIEW_SOURCE_SCOPE_CHANGED', 'La lectura no coincide con los IDs fijados.');
  for (const conversation of conversations) {
    const item = expected.get(conversation.id);
    if (!item || !ids.includes(conversation.id) || conversation.country !== item.country
      || conversation.activityDate !== item.activityDate || Date.parse(conversation.activityAt) !== Date.parse(item.activityAt)
      || String(conversation.sourceDocumentId) !== String(item.sourceDocumentId)
      || conversation.sourceDocumentHash !== item.sourceDocumentHash || conversation.messages?.length !== item.messageCount
      || sourceFingerprint(conversation) !== item.currentSourceHash) fail('SOURCE_CHANGED', 'Atom cambió desde la preparación. No se sustituyó ninguna conversación.');
  }
}

export function freshReviewConfiguration(state, registry, manifest) {
  if (state.metadata?.demo !== false) fail('REAL_MODE_REQUIRED', 'La corrida requiere las bases reales de Pulso y Atom.');
  if (state.settings.evaluationMaintenance) fail('EVALUATION_MAINTENANCE', 'Existe un mantenimiento activo; no se modificará.');
  const runtime = state.settings.automation ? runtimeConfiguration(state.settings.automation) : null;
  const bound = registry.forState(state).withRuntime(runtime);
  const profiles = manifest.profiles.map(id => bound.snapshot(bound.resolve(id)));
  if (profiles.some(profile => profile.provider !== 'gateway' || !hash.test(profile.configurationHash || ''))
    || profiles[0].model !== 'clef-flash' || profiles[1].model !== 'gemma-4-26b-a4b-it-mlx') fail('REVIEW_MODELS_CHANGED', 'Los perfiles no corresponden a Clef y Gemma configurados.');
  const snapshot = { catalogHash: digest(catalogReferences(state.catalog.filter(item => !item.retired))),
    runtimeHash: digest(runtime), profiles, policyVersion: bound.policy(state).version, runtime };
  const expected = manifest.expectedHashes;
  if (expected && (expected.catalogHash && expected.catalogHash !== snapshot.catalogHash
    || expected.runtimeHash && expected.runtimeHash !== snapshot.runtimeHash
    || expected.modelProfiles && profiles.some(profile => expected.modelProfiles[profile.id] !== profile.configurationHash))) fail('REVIEW_CONFIGURATION_CHANGED', 'La configuración difiere de la verificada para esta solicitud.');
  return snapshot;
}

export function freshReviewChunks(manifest) {
  validateFreshReviewManifest(manifest);
  const chunks = [];
  for (let offset = 0; offset < manifest.cases.length; offset += 100) chunks.push({
    index: chunks.length + 1, ids: manifest.cases.slice(offset, offset + 100).map(item => item.conversationId),
    idempotencyKey: `fresh-review:${manifest.id}:${manifest.selectionHash}:part-${chunks.length + 1}`,
  });
  return chunks;
}
export function freshReviewOptions(manifest, chunk, configuration) {
  return { purpose: 'operational', conversationIds: chunk.ids, pendingOnly: false, includeOpen: true,
    max: chunk.ids.length, modelIds: manifest.profiles, executionOrder: 'model-first', concurrency: 1,
    idempotencyKey: chunk.idempotencyKey, runtimeConfiguration: configuration.runtime,
    author: { id: null, name: 'Revisión nueva autorizada · ambos modelos' } };
}

// The bootstrap read contains jobs/settings/catalogs only. Once the first job is
// committed, every operation uses the existing scoped evaluation-worker store.
export function createFreshReviewStore(store, registry, manifest, chunk, configuration, existingJobId = null) {
  let jobId = existingJobId, target = store.evaluationWorker(jobId || `fresh-review-bootstrap:${manifest.id}`);
  const assertConfiguration = state => {
    if (!same(freshReviewConfiguration(state, registry, manifest), configuration)) fail('REVIEW_CONFIGURATION_CHANGED', 'La configuración cambió durante la corrida.');
  };
  const guard = {
    get jobId() { return jobId; },
    async read() { const state = await target.read(); assertConfiguration(state); return state; },
    async readWithConversations(options = {}) {
      const ids = options.conversationIds || chunk.ids;
      if (ids.some(id => !chunk.ids.includes(id))) fail('REVIEW_SOURCE_SCOPE_CHANGED', 'Un trabajador intentó salir del lote autorizado.');
      const state = await target.readWithConversations({ fresh: true, conversationIds: ids });
      assertConfiguration(state); assertFreshReviewSources(manifest, state.conversations, ids); return state;
    },
    async transaction(fn) {
      let committedJobId = jobId;
      const result = await target.transaction(async state => {
        assertConfiguration(state);
        const beforeSettings = JSON.stringify(state.settings), beforeMetadata = JSON.stringify(state.metadata);
        const foreign = new Map(state.jobs.filter(job => job.id !== jobId).map(job => [job.id, JSON.stringify(job)]));
        const foreignAnswers = new Map(state.evaluations.filter(answer => answer.jobId !== jobId).map(answer => [answer.id, JSON.stringify(answer)]));
        const result = await fn(state);
        const added = state.jobs.filter(job => !foreign.has(job.id) && job.id !== jobId);
        if (!jobId) {
          if (added.length !== 1 || added[0].idempotencyKey !== chunk.idempotencyKey
            || !same(added[0].conversationIds, chunk.ids) || added[0].automation || added[0].dailyActivity || added[0].oneOffRun) {
            fail('REVIEW_WORKER_SCOPE_CHANGED', 'La transacción no corresponde al lote nuevo autorizado.');
          }
          committedJobId = added[0].id;
          if (state.tasks.some(task => task.jobId !== committedJobId || task.evaluationId || task.profileStates || task.status !== 'pending')) {
            fail('REVIEW_REUSE_FORBIDDEN', 'La corrida nueva no puede reutilizar respuestas anteriores.');
          }
        } else if (added.length) fail('REVIEW_WORKER_SCOPE_CHANGED', 'Un trabajador intentó crear otro lote.');
        if (state.jobs.some(job => foreign.has(job.id) && foreign.get(job.id) !== JSON.stringify(job))) {
          fail('REVIEW_FOREIGN_JOB_CHANGED', 'Otra corrida requiere recuperación; este trabajador no cambiará su estado.');
        }
        if (beforeSettings !== JSON.stringify(state.settings) || beforeMetadata !== JSON.stringify(state.metadata)) {
          fail('REVIEW_SETTINGS_CHANGED', 'El trabajador no puede modificar programación, cuotas ni configuración.');
        }
        if (state.evaluations.some(answer => answer.jobId !== committedJobId && foreignAnswers.get(answer.id) !== JSON.stringify(answer))
          || state.operationalRefs.some(ref => !chunk.ids.includes(ref.id))) fail('REVIEW_WORKER_SCOPE_CHANGED', 'El trabajador intentó cambiar resultados o referencias ajenas.');
        if (state.tasks.some(task => task.jobId !== committedJobId) || state.attempts.some(attempt => attempt.jobId !== committedJobId)) {
          fail('REVIEW_WORKER_SCOPE_CHANGED', 'La transacción incluye tareas ajenas.');
        }
        return result;
      });
      if (jobId !== committedJobId) { jobId = committedJobId; target = store.evaluationWorker(jobId); }
      return result;
    },
  };
  return guard;
}

export async function executeFreshReview({ store, registry, manifest, progress, checkpoint = async () => {}, report = () => {},
  startBatch = startEvaluationBatch, resumeBatch = resumeEvaluationBatch, wait = pause, clock = () => new Date() }) {
  validateFreshReviewManifest(manifest, { authorize: true });
  const planned = freshReviewChunks(manifest);
  const initial = await store.evaluationWorker(`fresh-review-bootstrap:${manifest.id}`).read();
  const configuration = freshReviewConfiguration(initial, registry, manifest);
  if (progress && (progress.id !== manifest.id || progress.selectionHash !== manifest.selectionHash
    || !same(progress.configuration, configuration) || !same(progress.chunks.map(({ index, ids, idempotencyKey }) => ({ index, ids, idempotencyKey })), planned))) {
    fail('REVIEW_PROGRESS_CHANGED', 'El estado privado pertenece a otra selección o configuración.');
  }
  progress ||= { schemaVersion: 1, id: manifest.id, selectionHash: manifest.selectionHash, createdAt: clock().toISOString(),
    configuration, previousSelection: { id: initial.reviewSelection?.id || null, selectionHash: initial.reviewSelection?.selectionHash || null },
    status: 'prepared', chunks: planned };
  await checkpoint(progress);
  const deadline = Date.parse(manifest.reviewDeadline);
  const ensureTime = () => { if (clock().getTime() >= deadline) fail('REVIEW_DEADLINE_REACHED', 'La hora solicitada llegó antes de poder iniciar o reintentar el lote.'); };
  for (const chunk of progress.chunks) {
    ensureTime();
    const current = await store.readSchedulerState();
    const matches = current.jobs.filter(job => job.idempotencyKey === chunk.idempotencyKey);
    if (matches.length > 1 || chunk.jobId && matches[0]?.id !== chunk.jobId) fail('REVIEW_JOB_CHANGED', 'El lote guardado no coincide con su clave de ejecución.');
    const requested = freshReviewOptions(manifest, chunk, configuration);
    const requestHash = digest({ ...requested, onProgress: undefined, author: undefined });
    if (matches[0] && (matches[0].requestHash !== requestHash || !same(matches[0].modelProfiles, configuration.profiles) || matches[0].automation || matches[0].dailyActivity || matches[0].oneOffRun
      || !same(matches[0].conversationIds, chunk.ids) || matches[0].purpose !== 'operational' || matches[0].mode !== 'dual')) fail('REVIEW_JOB_CHANGED', 'La clave pertenece a una corrida incompatible.');
    const guarded = createFreshReviewStore(store, registry, manifest, chunk, configuration, matches[0]?.id || null);
    let job = matches[0] || null;
    if (job) chunk.jobId = job.id;
    let attempts = chunk.launchRounds || 0;
    while (!job || !['completed'].includes(job.status)) {
      ensureTime();
      if (job?.automation?.cancelledAt || job?.status === 'cancelled') fail('AUTOMATION_CANCELLED', 'Una corrida cancelada no se reanuda.');
      if (attempts >= 3) break;
      try {
        if (job) {
          const state = await guarded.read();
          job = state.jobs.find(value => value.id === job.id);
          if (job.status === 'completed') break;
          if (job.status === 'running') throw new AppError(409, 'La ejecución sigue activa.', 'EVALUATION_RUNNING');
          const unfinished = state.tasks.filter(task => task.jobId === job.id && !['completed', 'deferred'].includes(task.status));
          if (unfinished.some(task => task.error?.code && !retryable.has(task.error.code))) break;
        }
        const execution = job ? await resumeBatch(guarded, registry, job.id)
          : await startBatch(guarded, registry, freshReviewOptions(manifest, chunk, configuration));
        job = execution.job; chunk.jobId = job.id; chunk.launchRounds = ++attempts;
        progress.status = 'running'; chunk.status = job.status;
        await checkpoint(progress); report({ event: 'batch_started', part: chunk.index, jobId: job.id, cases: chunk.ids.length, round: attempts });
        job = await execution.completion;
        const state = await guarded.read(); job = state.jobs.find(value => value.id === chunk.jobId);
        chunk.status = job.status; chunk.models = evaluationModelProgress(state, job); chunk.updatedAt = clock().toISOString();
        await checkpoint(progress); report({ event: 'batch_finished', part: chunk.index, jobId: job.id, status: job.status, models: chunk.models });
      } catch (error) {
        if (!['EVALUATION_RUNNING', 'REVIEW_FOREIGN_JOB_CHANGED'].includes(error.code)) throw error;
        progress.status = 'waiting'; await checkpoint(progress);
        report({ event: 'waiting_for_worker', part: chunk.index, code: error.code });
        await wait(Math.min(15000, Math.max(1, deadline - clock().getTime())));
      }
    }
    if (job) { chunk.status = job.status; chunk.jobId = job.id; chunk.finishedAt = job.finishedAt || null; }
    await checkpoint(progress);
  }
  progress.status = progress.chunks.every(chunk => chunk.status === 'completed') ? 'completed' : 'attention';
  progress.finishedAt = progress.chunks.map(chunk => chunk.finishedAt).filter(Boolean).sort().at(-1) || clock().toISOString();
  if (progress.status === 'completed') delete progress.errorCode;
  await checkpoint(progress);
  return progress;
}

export function completedFreshReviewSelection(state, manifest, progress) {
  validateFreshReviewManifest(manifest, { authorize: true });
  if (progress?.status !== 'completed' || progress.id !== manifest.id || progress.selectionHash !== manifest.selectionHash
    || !same(progress.chunks.map(({ index, ids, idempotencyKey }) => ({ index, ids, idempotencyKey })), freshReviewChunks(manifest))) {
    fail('REVIEW_NOT_COMPLETE', 'La nueva corrida no está completa; no se reemplazó la selección visible.');
  }
  assertFreshReviewSources(manifest, state.conversations);
  const cases = manifest.cases.map(item => {
    const chunk = progress.chunks.find(chunk => chunk.ids.includes(item.conversationId));
    const job = state.jobs.find(job => job.id === chunk.jobId);
    if (!job || job.status !== 'completed' || job.idempotencyKey !== chunk.idempotencyKey || job.mode !== 'dual' || job.purpose !== 'operational'
      || job.createdAt < progress.createdAt || job.automation || job.dailyActivity || job.oneOffRun) fail('REVIEW_JOB_CHANGED', 'La ejecución completa no corresponde a esta revisión nueva.');
    const models = manifest.profiles.map(profileId => {
      const tasks = state.tasks.filter(task => task.jobId === job.id && task.conversationId === item.conversationId && task.profile.id === profileId);
      if (tasks.length !== 1 || tasks[0].status !== 'completed' || tasks[0].reusedEvaluationId) fail('REVIEW_NOT_COMPLETE', 'Falta una respuesta nueva completa de uno de los modelos.');
      const task = tasks[0], evaluation = state.evaluations.find(evaluation => evaluation.id === task.evaluationId);
      if (!evaluation || evaluation.jobId !== job.id || evaluation.taskId !== task.id || evaluation.createdAt < job.createdAt
        || evaluation.sourceHash !== item.currentSourceHash) fail('REVIEW_NOT_COMPLETE', 'Una respuesta no pertenece al input y al lote nuevos.');
      return { profileId, provider: evaluation.provider, model: evaluation.model, taskId: task.id, evaluationId: evaluation.id,
        evaluatedAt: evaluation.createdAt, configurationHash: evaluation.modelConfiguration?.configurationHash,
        modelPromptHash: evaluation.modelPromptHash, resultCount: evaluation.results.length, status: 'completed' };
    });
    const publishedId = state.operationalRefs.find(ref => ref.id === item.conversationId)?.evaluationId;
    const published = state.evaluations.find(evaluation => evaluation.id === publishedId);
    if (!published || published.jobId !== job.id) fail('REVIEW_PUBLICATION_SUPERSEDED', 'Otra corrida publicó una referencia posterior; la muestra nueva requiere comprobación.');
    const anchorModel = models.find(model => model.profileId === published.profileId);
    if (!anchorModel) fail('REVIEW_NOT_COMPLETE', 'No existe un ancla del modelo publicado dentro del par nuevo.');
    const anchor = state.evaluations.find(evaluation => evaluation.id === anchorModel.evaluationId);
    return { conversationId: item.conversationId, country: item.country, activityDate: item.activityDate, activityAt: item.activityAt,
      sourceDocumentId: item.sourceDocumentId, sourceDocumentHash: item.sourceDocumentHash, sourceCompleted: item.sourceCompleted,
      jobId: job.id, publishedAnchorEvaluationId: publishedId, selectionAnchorEvaluationId: anchor.id,
      sourceHash: item.currentSourceHash, currentSourceHash: item.currentSourceHash, sourceChanged: false,
      context: Object.fromEntries(['catalogHash', 'promptHash', 'promptVersion', 'rulesVersion'].map(key => [key, anchor[key]])), models };
  });
  const selection = { schemaVersion: 1, id: manifest.id, title: 'Revisión nueva del 17 al 19 de noviembre',
    createdAt: new Date().toISOString(), reviewDeadline: manifest.reviewDeadline, scope: manifest.scope,
    caseCount: cases.length, evaluationCount: cases.length * 2, counts: manifest.counts, cases,
    sourceChangedCount: 0, timeCorrectionCount: 0, freshRun: { id: manifest.id, requestedAt: progress.createdAt, completedAt: progress.finishedAt,
      jobIds: progress.chunks.map(chunk => chunk.jobId), sourceSelectionHash: manifest.selectionHash } };
  selection.selectionHash = digest({ scope: selection.scope, cases });
  applyReviewSelection({ ...state, reviewSelection: selection }, selection.id);
  return selection;
}
