import { needsEvaluation, currentEvaluation } from './source-state.js';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { evaluateCodeVariables, supportsCodeVariable } from './code-evaluator.js';
import { supportsAiVariable } from './evaluator.js';
import { catalogAvailability } from './catalog-presentation.js';
import { asRegistry } from './model-registry.js';
import { catalogReferences, digest, ensureEvaluationState, evaluationContext, selectedEvaluation, sourceFingerprint } from './evaluation-context.js';
import { startEvaluationHeartbeat } from './evaluation-heartbeat.js';

const retryable = error => ['AI_UNAVAILABLE', 'AI_TRANSIENT', 'INVALID_AI_RESULT', 'AI_INCOMPLETE'].includes(error.code);
const running = new Map();
const now = () => new Date().toISOString();
const safeError = error => ({ code: error instanceof AppError ? error.code : 'EVALUATION_FAILED', message: error instanceof AppError ? error.message : 'No se pudo completar esta evaluación.' });
const readHistory = (store, conversationIds) => store.readWithConversations
  ? store.readWithConversations({ fresh: true, ...(conversationIds !== undefined ? { conversationIds } : {}) }) : store.read();
const requestIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const nativeFailureCodes = new Set(['AI_CONFIGURATION', 'AI_UNAVAILABLE', 'AI_TRANSIENT', 'INVALID_AI_RESULT',
  'MODEL_CHANGED', 'MODEL_IDENTITY_UNVERIFIED', 'AI_SAFETY_REFUSAL', 'AI_INCOMPLETE', 'UNSUPPORTED_VARIABLE',
  'EMPTY_CONVERSATION', 'UNSUPPORTED_INPUT', 'INPUT_CAPACITY_EXCEEDED', 'INVALID_GATEWAY_CATALOG', 'MODEL_UNAVAILABLE']);

// Native decisions use a separate protocol and instruction contract. Keep this
// metadata outside the shared context so legacy Gemma fingerprints stay intact.
function nativeMetadata(response, profile, variableIds) {
  if (profile.evaluator.protocol !== 'systemone') return {};
  if (response?.protocol !== 'systemone' || response.adapterVersion !== profile.evaluator.adapterVersion
    || !/^[a-f0-9]{64}$/.test(response.instructionsHash || '')
    || (profile.evaluator.instructionsHash && response.instructionsHash !== profile.evaluator.instructionsHash)
    || !Array.isArray(response.requestIds) || response.requestIds.some(id => typeof id !== 'string' || !requestIdPattern.test(id))
    || !Array.isArray(response.requests)) {
    throw new AppError(409, 'La procedencia del adaptador no coincide con el perfil solicitado.', 'MODEL_CHANGED');
  }
  const requests = response.requests.map(request => {
    if (!request || !['inventory', 'classification', 'evidence'].includes(request.stage)
      || (request.requestId != null && (typeof request.requestId !== 'string' || !requestIdPattern.test(request.requestId)))
      || !Array.isArray(request.variableIds) || request.variableIds.some(id => !variableIds.includes(id))
      || !Number.isFinite(request.durationMs) || request.durationMs < 0) {
      throw new AppError(502, 'La procedencia de una solicitud del adaptador es inválida.', 'INVALID_AI_RESULT');
    }
    return { requestId: request.requestId ?? null, stage: request.stage, variableIds: [...request.variableIds], durationMs: request.durationMs,
      ...(Number.isSafeInteger(request.inputBytes) && request.inputBytes >= 0 ? { inputBytes: request.inputBytes } : {}),
      ...(nativeFailureCodes.has(request.errorCode) ? { errorCode: request.errorCode } : {}) };
  });
  return { protocol: 'systemone', adapterVersion: response.adapterVersion, instructionsHash: response.instructionsHash,
    requestIds: [...new Set(response.requestIds)], requests };
}
function accumulatedMetadata(previous, current, attemptId) {
  if (!current.protocol) return {};
  if (previous?.protocol && ['protocol', 'adapterVersion', 'instructionsHash'].some(key => previous[key] !== current[key])) {
    throw new AppError(409, 'Las instrucciones del adaptador cambiaron durante el reintento.', 'PROMPT_CHANGED');
  }
  return { ...current, requestIds: [...new Set([...(previous?.requestIds || []), ...current.requestIds])],
    requests: [...(previous?.requests || []), ...current.requests.map(request => ({ ...request, attemptId }))] };
}

export function eligibleConversations(state, { from, to, country, pendingOnly = true, sourceChangedAfter, includeOpen = state.settings?.includeOpenConversations === true, refreshChanged = state.settings?.refreshChangedConversations === true } = {}) {
  return state.conversations.filter(c => c.messages.length && (includeOpen || c.completed !== false) && (!from || c.date >= from) && (!to || c.date <= to)
    && (!country || c.country === country) && (!pendingOnly || needsEvaluation(state, c, refreshChanged)) && (!sourceChangedAfter || (c.sourceCreatedAt >= sourceChangedAfter || c.sourceUpdatedAt >= sourceChangedAfter || (refreshChanged && !!currentEvaluation(state, c)?.sourceHash && needsEvaluation(state, c, true)))));
}

function validateCatalog(catalog) {
  const active = catalog.filter(v => v.active);
  if (!active.length || active.some(v => !catalogAvailability(v).canActivate)) throw new AppError(422, 'El checklist activo incluye una fase, regla o integración que aún no está implementada. Revisa su disponibilidad en el catálogo.', 'UNSUPPORTED_VARIABLE');
}
function restoreCatalog(state, refs) {
  return refs.map(ref => {
    const v = state.catalogVersions.find(v => v.itemId === ref.id && v.version === ref.version)?.snapshot;
    if (!v) throw new AppError(409, 'Falta una versión del checklist.', 'MISSING_CATALOG_VERSION');
    return { ...v, active: ref.active };
  });
}
function recoverInterrupted(state) {
  const cutoff = Date.now() - 10 * 60_000;
  for (const job of state.jobs) if (job.status === 'running' && Date.parse(job.updatedAt || job.createdAt) < cutoff) {
    job.status = 'interrupted'; job.finishedAt = now();
    for (const task of state.tasks.filter(t => t.jobId === job.id && t.status === 'running')) task.status = 'interrupted';
    for (const attempt of state.attempts.filter(a => a.jobId === job.id && a.status === 'running')) { attempt.status = 'interrupted'; attempt.finishedAt = now(); }
  }
}
export async function recoverEvaluationJobs(store) {
  const state = await store.read();
  if (state.jobs.some(j => j.status === 'running' && Date.parse(j.updatedAt || j.createdAt) < Date.now() - 10 * 60_000)) await store.transaction(recoverInterrupted);
}
function pickCandidates(state, options) {
  let candidates = eligibleConversations(state, options);
  if (options.conversationIds) {
    if (!Array.isArray(options.conversationIds) || !options.conversationIds.length || new Set(options.conversationIds).size !== options.conversationIds.length) throw new AppError(422, 'La lista de conversaciones para revisión es inválida.', 'INVALID_RECHECK');
    const byId = new Map(candidates.map(c => [c.id, c]));
    candidates = options.conversationIds.map(id => byId.get(id));
    if (candidates.some(c => !c)) throw new AppError(422, 'Una conversación de la muestra ya no está disponible.', 'INVALID_RECHECK');
  } else if (options.random) {
    // Shuffle first and include both historical strata when available. Persist
    // membership before any calls; this is an audit sample, not prevalence data.
    candidates = [...candidates];
    for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
    if ((options.max ?? 20) >= 2) {
      const hasFlag = e => e?.results.some(r => r.value === 1 && state.catalog.find(v => v.id === r.variableId)?.type === 'Flag');
      const withFlag = candidates.find(c => hasFlag(selectedEvaluation(state, c)));
      const withoutFlag = candidates.find(c => { const e = selectedEvaluation(state, c); return e && e.results.some(r => r.status === 'evaluado') && !hasFlag(e); });
      if (withFlag && withoutFlag) candidates = [withFlag, withoutFlag, ...candidates.filter(c => c.id !== withFlag.id && c.id !== withoutFlag.id)];
    }
  }
  return candidates.slice(0, options.max ?? 20);
}
export async function startEvaluationBatch(store, evaluator, options = {}) {
  const state = ensureEvaluationState(await readHistory(store, options.conversationIds));
  const registry = asRegistry(evaluator).forState(state);
  if (!registry.configured) throw new AppError(503, 'Falta configurar un modelo habilitado.', 'AI_NOT_CONFIGURED');
  if (state.settings.evaluationMaintenance && state.settings.evaluationMaintenance !== options.maintenanceId) throw new AppError(409, 'Se está renovando el histórico de evaluaciones.', 'EVALUATION_MAINTENANCE');
  const purpose = options.purpose || 'operational';
  const limit = options.scheduleDate ? 100 : 20;
  if (options.max != null && (!Number.isInteger(options.max) || options.max < 1 || options.max > limit)) throw new AppError(422, `El máximo de esta ejecución es ${limit} conversaciones.`, 'INVALID_BATCH_SIZE');
  const requestHash = digest({ ...options, onProgress: undefined, author: undefined });
  if (options.idempotencyKey) {
    const previous = state.jobs.find(j => j.idempotencyKey === options.idempotencyKey);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new AppError(409, 'La clave de ejecución ya se utilizó con otros parámetros.', 'IDEMPOTENCY_CONFLICT');
      return { job: previous, completion: running.get(previous.id) || Promise.resolve(previous) };
    }
  }
  validateCatalog(state.catalog);
  const policy = registry.policy(state);
  const dual = purpose === 'operational' && policy.mode === 'dual';
  const requestedIds = purpose === 'comparison' ? options.modelIds : dual ? [policy.primaryId, policy.secondaryId] : [policy.primaryId];
  if (!Array.isArray(requestedIds) || !requestedIds.length || requestedIds.length > 3 || new Set(requestedIds).size !== requestedIds.length || (purpose === 'comparison' && requestedIds.length < 2)) throw new AppError(422, 'Selecciona entre dos y tres modelos distintos para comparar.', 'INVALID_MODELS');
  const profiles = requestedIds.map(id => registry.snapshot(registry.resolve(id)));
  if (new Set(profiles.map(p => `${p.provider}:${p.model}`)).size !== profiles.length) throw new AppError(422, 'Dos perfiles apuntan al mismo modelo. Selecciona modelos distintos.', 'DUPLICATE_MODEL');
  const fallback = purpose === 'operational' && !dual && policy.fallbackId ? registry.snapshot(registry.resolve(policy.fallbackId)) : null;
  if (fallback && fallback.provider === profiles[0].provider && fallback.model === profiles[0].model) throw new AppError(422, 'El respaldo debe ser un modelo diferente.', 'DUPLICATE_MODEL');
  const pendingOnly = purpose === 'comparison' ? false : options.pendingOnly !== false;
  const candidates = pickCandidates(state, { ...options, pendingOnly });
  if (!candidates.length && purpose === 'comparison') throw new AppError(422, 'No hay conversaciones disponibles con estos filtros.', 'EMPTY_SAMPLE');
  const catalog = state.catalog.filter(v => !v.retired);
  const catalogVersions = catalogReferences(catalog);
  const job = { id: randomUUID(), purpose, status: 'running', scope: options.scheduleDate ? 'daily' : options.conversationIds ? 'recheck' : pendingOnly ? 'pending' : 'period',
    sourceJobId: options.sourceJobId || null, scheduleDate: options.scheduleDate || null, from: options.from || null, to: options.to || null, country: options.country || null,
    total: candidates.length * profiles.length, caseCount: candidates.length, completed: 0, failed: 0, errors: [], conversationIds: candidates.map(c => c.id),
    modelProfiles: profiles, fallback, mode: dual ? 'dual' : 'single', concurrency: Math.min(3, Math.max(1, Number(options.concurrency) || 1)), maintenanceId: options.maintenanceId || null, policyVersion: policy.version, catalogVersions, pendingOnly, demo: !!state.metadata.demo,
    idempotencyKey: options.idempotencyKey || null, requestHash, createdAt: now(), updatedAt: now(), finishedAt: null };
  const tasks = candidates.flatMap(c => {
    const codeResults = evaluateCodeVariables(c, catalog.filter(v => v.active && supportsCodeVariable(v)));
    return profiles.map(profile => ({ id: randomUUID(), jobId: job.id, conversationId: c.id,
      profile, fallback, codeResults, context: evaluationContext(c, catalog), status: 'pending', round: 1, evaluationId: null, error: null }));
  });
  await store.transaction(draft => {
    ensureEvaluationState(draft); recoverInterrupted(draft);
    if (draft.settings.evaluationMaintenance && draft.settings.evaluationMaintenance !== options.maintenanceId) throw new AppError(409, 'Se está renovando el histórico de evaluaciones.', 'EVALUATION_MAINTENANCE');
    if (registry.policy(draft).version !== policy.version) throw new AppError(409, 'La política cambió. Vuelve a iniciar la evaluación.', 'VERSION_CONFLICT');
    const currentRegistry = registry.forState(draft);
    for (const profile of [...profiles, fallback].filter(Boolean)) currentRegistry.resolve(profile.id, profile);
    if (options.idempotencyKey && draft.jobs.some(j => j.idempotencyKey === options.idempotencyKey)) throw new AppError(409, 'Esta ejecución ya se registró. Consulta su progreso.', 'DUPLICATE_EXECUTION');
    if (options.scheduleDate) {
      if (!draft.settings.dailyEnabled || draft.settings.dailyStartedAt !== options.sourceChangedAfter) throw new AppError(409, 'La programación diaria cambió.', 'SCHEDULE_CHANGED');
      if (draft.jobs.some(j => j.scheduleDate === options.scheduleDate)) throw new AppError(409, 'La ejecución diaria ya se inició.', 'DAILY_ALREADY_STARTED');
    }
    if (draft.jobs.some(j => j.status === 'running')) throw new AppError(409, 'Ya hay una evaluación en curso.', 'EVALUATION_RUNNING');
    draft.jobs.push(job); draft.tasks.push(...tasks);
    if (purpose === 'comparison') draft.comparisons.push({ id: job.id, name: options.name || `Muestra ${now().slice(0, 10)}`,
      jobId: job.id, modelProfiles: profiles, catalogVersions, createdAt: job.createdAt, demo: job.demo, authorName: options.author?.name || null,
      cases: candidates.map(c => ({ conversationId: c.id, country: c.country, date: c.date, ...evaluationContext(c, catalog),
        codeResults: tasks.find(t => t.conversationId === c.id)?.codeResults || [] })) });
  });
  return { job, completion: launch(store, registry, job, catalog, options.onProgress) };
}
function launch(store, registry, job, catalog, onProgress, selectedTaskIds) {
  const completion = processJob(store, registry, job, catalog, onProgress, selectedTaskIds);
  running.set(job.id, completion);
  completion.finally(() => running.delete(job.id)).catch(() => {});
  return completion;
}
async function processJob(store, registry, job, catalog, onProgress, selectedTaskIds) {
  const stopHeartbeat = startEvaluationHeartbeat(() => store.transaction(s => {
    const current = s.jobs.find(j => j.id === job.id);
    if (current?.status === 'running') current.updatedAt = now();
  }));
  try {
    const tasks = (await store.read()).tasks.filter(t => t.jobId === job.id && t.status !== 'completed' && (!selectedTaskIds || selectedTaskIds.includes(t.id)));
    const cases = [...new Set(tasks.map(t => t.conversationId))];
    const worker = async () => { while (cases.length) { const conversationId = cases.shift();
    for (const task of tasks.filter(t => t.conversationId === conversationId)) {
      let error = null;
      try {
        // Atom may change while a long batch is running. Re-read before each task.
        const fresh = await readHistory(store, [task.conversationId]);
        const conversation = fresh.conversations.find(c => c.id === task.conversationId);
        await processTask(store, registry, job, task, conversation, catalog);
      }
      catch (caught) { error = safeError(caught); }
      await store.transaction(draft => {
        const current = draft.tasks.find(t => t.id === task.id);
        if (error && current.status !== 'completed' && current.round === task.round) { current.status = 'failed'; current.error = error; }
        updateJob(draft, job.id, false);
      });
      if (onProgress) await onProgress({ conversationId: task.conversationId, error: error?.message || null });
    }
    } };
    await Promise.all(Array.from({ length: job.concurrency || 1 }, worker));
    await store.transaction(draft => updateJob(draft, job.id, true, selectedTaskIds));
    return (await store.read()).jobs.find(j => j.id === job.id);
  } finally { await stopHeartbeat(); }
}
function updateJob(state, id, finished, selectedTaskIds) {
  const job = state.jobs.find(j => j.id === id), tasks = state.tasks.filter(t => t.jobId === id);
  job.completed = tasks.filter(t => t.status === 'completed').length;
  job.failed = tasks.filter(t => ['failed', 'partial'].includes(t.status)).length;
  job.partial = tasks.filter(t => t.status === 'partial').length;
  job.errors = tasks.filter(t => t.error).map(t => ({ conversationId: t.conversationId, profileId: t.profile.id, ...t.error }));
  job.updatedAt = now();
  if (finished && tasks.every(t => ['completed', 'failed', 'partial'].includes(t.status))) { job.status = job.failed ? (job.completed || job.partial ? 'partial' : 'failed') : 'completed'; job.finishedAt = now(); }
  else if (finished && selectedTaskIds && tasks.filter(t => selectedTaskIds.includes(t.id)).every(t => ['completed', 'failed', 'partial'].includes(t.status))) {
    // A scoped maintenance retry can leave changed/missing cases untouched.
    // They remain pending; the worker has stopped and must not look live forever.
    job.status = 'interrupted'; job.finishedAt = now();
  }
}
async function processTask(store, registry, job, task, conversation, catalog) {
  if (!conversation || task.context.sourceHash !== sourceFingerprint(conversation)) throw new AppError(409, 'El contenido de Atom cambió. Crea una nueva muestra.', 'SOURCE_CHANGED');
  const currentContext = evaluationContext(conversation, catalog);
  if (currentContext.promptHash !== task.context.promptHash || currentContext.rulesVersion !== task.context.rulesVersion) throw new AppError(409, 'Las instrucciones cambiaron. Crea una nueva ejecución.', 'PROMPT_CHANGED');
  const claimed = await store.transaction(s => { const t = s.tasks.find(t => t.id === task.id); if (t.status === 'completed' || t.round !== task.round) return false; t.status = 'running'; t.error = null; return true; });
  if (!claimed) return;
  const aiVariables = catalog.filter(v => v.active && supportsAiVariable(v));
  const codeResults = task.codeResults || evaluateCodeVariables(conversation, catalog.filter(v => v.active && supportsCodeVariable(v)));
  // Each profile retains its own successful items. Never blend answers from two
  // providers under one model identity, including during fallback or resumption.
  let answer, effective, lastError, selectedState;
  const profileStates = structuredClone(task.profileStates || {});
  for (const snapshot of [task.profile, task.fallback].filter(Boolean)) {
    // Never fall back after a non-technical refusal or a configuration/input error.
    if (lastError && !retryable(lastError)) break;
    const profile = registry.resolve(snapshot.id, snapshot);
    const previous = profileStates[profile.id];
    const retained = new Map((previous?.results || []).map(r => [r.variableId, r]));
    let metadata = previous || { model: profile.model, responseId: null, usage: null };
    let itemErrors = previous?.validationErrors || [];
    for (let index = 0; index < 2; index++) {
      const pending = aiVariables.filter(v => !retained.has(v.id));
      if (!pending.length) { lastError = null; break; }
      const attempt = { id: randomUUID(), jobId: job.id, taskId: task.id, round: task.round, profileId: profile.id,
        provider: profile.provider, requestedModel: profile.model, variableIds: pending.map(v => v.id), status: 'running', startedAt: now() };
      await store.transaction(s => s.attempts.push(attempt));
      const started = Date.now();
      let attemptMetadata = {};
      try {
        const response = await profile.evaluator.evaluate(conversation, pending, {
          validationErrors: itemErrors.map(({ variableId, rules }) => ({ variableId, rules })),
        });
        if (!Array.isArray(response.results) || response.results.some(r => !pending.some(v => v.id === r.variableId)) || new Set(response.results.map(r => r.variableId)).size !== response.results.length) throw new AppError(502, 'Resultado estructurado incompleto o duplicado.', 'INVALID_AI_RESULT');
        const actualModel = response.model || profile.model;
        if (retained.size && metadata.model !== actualModel) throw new AppError(409, 'El proveedor cambió el modelo efectivo durante el reintento.', 'MODEL_CHANGED');
        attemptMetadata = nativeMetadata(response, profile, pending.map(v => v.id));
        const provenance = accumulatedMetadata(metadata, attemptMetadata, attempt.id);
        for (const result of response.results) retained.set(result.variableId, result);
        metadata = { model: actualModel, responseId: response.responseId || null, usage: response.usage || null, ...provenance };
        itemErrors = pending.filter(v => !retained.has(v.id)).map(v => {
          const failure = response.validationErrors?.find(e => e.variableId === v.id);
          return { variableId: v.id, code: 'INVALID_AI_RESULT', rules: failure?.rules || ['missing_item'], message: failure?.message || `Falta un resultado válido para ${v.id}.` };
        });
        lastError = itemErrors.length ? new AppError(502,
          response.failure ? 'No se pudo completar una etapa del adaptador.' : `${itemErrors.length} variables requieren reintento por formato inválido.`,
          response.failure ? nativeFailureCodes.has(response.failure.code) ? response.failure.code : 'EVALUATION_FAILED' : 'INVALID_AI_RESULT') : null;
        profileStates[profile.id] = { ...metadata, results: [...retained.values()], validationErrors: itemErrors };
        await store.transaction(s => {
          Object.assign(s.attempts.find(a => a.id === attempt.id), { status: lastError ? 'partial' : 'completed', finishedAt: now(), durationMs: Date.now() - started,
            actualModel, usage: response.usage || null, ...attemptMetadata, validationErrors: itemErrors, validVariableIds: response.results.map(r => r.variableId), error: lastError ? safeError(lastError) : null });
          s.tasks.find(t => t.id === task.id).profileStates = structuredClone(profileStates);
        });
        if (!lastError || !retryable(lastError)) break;
      } catch (error) {
        lastError = error;
        if (error?.evaluationMetadata) {
          try {
            attemptMetadata = nativeMetadata(error.evaluationMetadata, profile, pending.map(v => v.id));
            metadata = { ...metadata, ...accumulatedMetadata(metadata, attemptMetadata, attempt.id) };
          } catch (provenanceError) { lastError = provenanceError; }
        }
        itemErrors = pending.map(v => ({ variableId: v.id, ...safeError(lastError) }));
        profileStates[profile.id] = { ...metadata, results: [...retained.values()], validationErrors: itemErrors };
        await store.transaction(s => {
          Object.assign(s.attempts.find(a => a.id === attempt.id), { status: 'failed', finishedAt: now(), durationMs: Date.now() - started,
            ...attemptMetadata, error: safeError(lastError), validationErrors: itemErrors });
          s.tasks.find(t => t.id === task.id).profileStates = structuredClone(profileStates);
        });
        if (!retryable(lastError)) break;
      }
      if (index === 0 && profile.provider !== 'demo') await new Promise(resolve => setTimeout(resolve, 250));
    }
    const candidate = { ...metadata, results: [...retained.values()], validationErrors: itemErrors, error: lastError };
    if (!selectedState || candidate.results.length > selectedState.results.length || !lastError) { selectedState = candidate; effective = profile; }
    if (!lastError) break;
  }
  answer = selectedState;
  if (!answer || (!answer.results.length && !codeResults.length && lastError)) throw lastError;
  const pending = aiVariables.filter(v => !answer.results.some(r => r.variableId === v.id));
  const partial = pending.length > 0;
  const failure = partial ? answer.error || lastError || new AppError(502, 'Hay variables pendientes de respuesta válida.', 'INVALID_AI_RESULT') : null;
  const invalidResults = pending.map(v => ({ variableId: v.id, type: v.type, method: v.method, status: 'no_evaluado', value: null, evidence: [],
    reason: 'No se obtuvo una respuesta válida del modelo. Revisión pendiente.', error: answer.validationErrors.find(e => e.variableId === v.id) || { variableId: v.id, ...safeError(failure) } }));
  const evaluation = { id: randomUUID(), conversationId: conversation.id, jobId: job.id, taskId: task.id, purpose: job.purpose,
    createdAt: now(), demo: job.demo, ...task.context, provisional: conversation.completed === false, sourceUpdatedAt: conversation.sourceUpdatedAt || null, profileId: effective.id, provider: effective.provider,
    profileLabel: effective.label, requestedProfileId: task.profile.id, requestedProvider: task.profile.provider, requestedModel: task.profile.model,
    model: answer.model || effective.model, modelConfiguration: registry.snapshot(effective), usedFallback: effective.id !== task.profile.id,
    ...(answer.protocol ? { protocol: answer.protocol, adapterVersion: answer.adapterVersion, instructionsHash: answer.instructionsHash,
      requestIds: answer.requestIds, requests: answer.requests } : {}),
    providerResponseId: answer.responseId || null, usage: answer.usage || null, catalogVersions: job.catalogVersions,
    partial, validationErrors: answer.validationErrors, results: [...answer.results, ...invalidResults, ...codeResults] };
  const fresh = await readHistory(store, [conversation.id]);
  const source = fresh.conversations.find(c => c.id === conversation.id);
  if (!source || sourceFingerprint(source) !== task.context.sourceHash) throw new AppError(409, 'Atom cambió durante la evaluación. Evalúa el contenido nuevo.', 'SOURCE_CHANGED');
  await store.transaction(state => {
    const current = state.tasks.find(t => t.id === task.id);
    if (digest(catalogReferences(state.catalog)) !== task.context.catalogHash) throw new AppError(409, 'El checklist cambió durante la evaluación.', 'CATALOG_CHANGED');
    if (current.status === 'completed' || current.round !== task.round) return;
    evaluation.attemptIds = state.attempts.filter(a => a.taskId === task.id).map(a => a.id);
    evaluation.durationMs = state.attempts.filter(a => a.taskId === task.id).reduce((n, a) => n + (a.durationMs || 0), 0);
    state.evaluations.push(evaluation);
    if (job.purpose === 'operational') {
      const ref = state.operationalRefs.find(r => r.id === conversation.id);
      const anchor = state.evaluations.find(e => e.id === ref?.evaluationId);
      const primary = state.tasks.find(t => t.jobId === job.id && t.conversationId === conversation.id && t.profile.id === job.modelProfiles[0].id);
      if (job.mode === 'dual' && task.profile.id !== primary?.profile.id && ['failed', 'partial'].includes(primary?.status) && retryable(primary.error || {})) evaluation.contingencyFor = primary.profile;
      const blockedPrimary = job.mode === 'dual' && ['failed', 'partial'].includes(primary?.status) && !retryable(primary.error || {});
      const blockedCurrent = partial && failure && !retryable(failure);
      const newer = state.jobs.some(j => j.id !== job.id && j.purpose === 'operational' && j.createdAt > job.createdAt && j.conversationIds.includes(conversation.id));
      if (!blockedPrimary && !blockedCurrent && !newer) {
        if (ref && (job.mode !== 'dual' || anchor?.jobId !== job.id)) ref.evaluationId = evaluation.id;
        else if (!ref) state.operationalRefs.push({ id: conversation.id, evaluationId: evaluation.id });
      }
    }
    Object.assign(current, { status: partial ? 'partial' : 'completed', evaluationId: evaluation.id, error: failure ? safeError(failure) : null });
  });
}
export async function resumeEvaluationBatch(store, evaluator, jobId, { conversationIds } = {}) {
  const storedState = await store.read();
  const storedJob = storedState.jobs?.find(j => j.id === jobId);
  if (!storedJob?.modelProfiles) throw new AppError(404, 'La ejecución no admite reanudación.', 'NOT_FOUND');
  const scoped = conversationIds !== undefined;
  if (scoped && (!Array.isArray(conversationIds) || !conversationIds.length || new Set(conversationIds).size !== conversationIds.length
    || conversationIds.some(id => !storedJob.conversationIds.includes(id)))) throw new AppError(422, 'La selección no pertenece a esta ejecución.', 'INVALID_RECHECK');
  if (scoped && (!storedJob.maintenanceId || storedState.settings.evaluationMaintenance !== storedJob.maintenanceId)) throw new AppError(409, 'La reanudación parcial requiere el mismo mantenimiento activo.', 'EVALUATION_MAINTENANCE');
  const state = ensureEvaluationState(await readHistory(store, scoped ? conversationIds : storedJob.conversationIds));
  const registry = asRegistry(evaluator).forState(state);
  const job = state.jobs.find(j => j.id === jobId);
  if (!job || !job.modelProfiles) throw new AppError(404, 'La ejecución no admite reanudación.', 'NOT_FOUND');
  if (state.settings.evaluationMaintenance && state.settings.evaluationMaintenance !== job.maintenanceId) throw new AppError(409, 'Se está renovando el histórico de evaluaciones.', 'EVALUATION_MAINTENANCE');
  const catalog = restoreCatalog(state, job.catalogVersions);
  // MySQL JSON may reorder object keys; normalize both reference sets without
  // changing the digest function or any historical context fingerprints.
  if (digest(catalogReferences(state.catalog)) !== digest(catalogReferences(job.catalogVersions))) throw new AppError(409, 'El checklist cambió. Inicia una nueva ejecución.', 'CATALOG_CHANGED');
  if (state.jobs.some(j => j.id !== job.id && j.purpose === 'operational' && j.createdAt > job.createdAt && j.conversationIds.some(id => job.conversationIds.includes(id)))) throw new AppError(409, 'Existe una ejecución operativa posterior. Consulta el resultado vigente.', 'SUPERSEDED_JOB');
  const candidates = job.conversationIds.map(id => state.conversations.find(c => c.id === id)).filter(Boolean);
  const pending = state.tasks.filter(t => t.jobId === jobId && t.status !== 'completed' && (!scoped || conversationIds.includes(t.conversationId)));
  if (!pending.length) throw new AppError(409, 'La ejecución ya está completa.', 'ALREADY_COMPLETED');
  for (const task of pending) {
    const c = candidates.find(c => c.id === task.conversationId);
    if (!c || sourceFingerprint(c) !== task.context.sourceHash) throw new AppError(409, 'Atom cambió. Crea una nueva muestra.', 'SOURCE_CHANGED');
    const context = evaluationContext(c, catalog);
    if (context.promptHash !== task.context.promptHash || context.rulesVersion !== task.context.rulesVersion) throw new AppError(409, 'Las instrucciones o reglas cambiaron. Inicia una nueva ejecución para usar el checklist vigente.', 'PROMPT_CHANGED');
    registry.resolve(task.profile.id, task.profile);
  }
  await store.transaction(s => {
    recoverInterrupted(s);
    if (s.settings.evaluationMaintenance && s.settings.evaluationMaintenance !== job.maintenanceId) throw new AppError(409, 'Se está renovando el histórico de evaluaciones.', 'EVALUATION_MAINTENANCE');
    if (scoped && s.settings.evaluationMaintenance !== job.maintenanceId) throw new AppError(409, 'El mantenimiento de la reanudación parcial cambió.', 'EVALUATION_MAINTENANCE');
    if (s.jobs.some(j => j.status === 'running')) throw new AppError(409, 'Ya hay una evaluación en curso.', 'EVALUATION_RUNNING');
    const currentRegistry = registry.forState(s);
    for (const task of pending) {
      currentRegistry.resolve(task.profile.id, task.profile);
      if (task.fallback) currentRegistry.resolve(task.fallback.id, task.fallback);
    }
    const j = s.jobs.find(j => j.id === jobId); Object.assign(j, { status: 'running', updatedAt: now(), finishedAt: null });
    const selectedIds = new Set(pending.map(t => t.id));
    for (const t of s.tasks.filter(t => selectedIds.has(t.id) && t.status !== 'completed')) { t.status = 'pending'; t.round++; t.error = null; }
  });
  const resumedJob = (await store.read()).jobs.find(j => j.id === jobId);
  return { job: resumedJob, completion: launch(store, registry, resumedJob, catalog, undefined, scoped ? pending.map(t => t.id) : undefined) };
}
export async function runEvaluationBatch(store, evaluator, options) { return (await startEvaluationBatch(store, evaluator, options)).completion; }
export async function evaluateConversation(store, evaluator, conversation, catalog, { replace = false } = {}) {
  // Compatibility entry point for callers; the batch service owns persistence and attempts.
  const job = await runEvaluationBatch(store, evaluator, { conversationIds: [conversation.id], pendingOnly: !replace, max: 1 });
  if (job.failed) throw new AppError(502, job.errors[0].message, job.errors[0].code);
  return (await store.read()).evaluations.find(e => e.jobId === job.id);
}
