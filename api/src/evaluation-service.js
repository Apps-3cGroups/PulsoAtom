import { needsEvaluation, currentEvaluation } from './source-state.js';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { evaluateCodeVariable, supportsCodeVariable } from './code-evaluator.js';
import { asRegistry } from './model-registry.js';
import { catalogReferences, digest, ensureEvaluationState, evaluationContext, selectedEvaluation, sourceFingerprint } from './evaluation-context.js';

const supportsAiVariable = v => v.type === 'Flag' && ['IA', 'IA + código'].includes(v.method);
const retryable = error => ['AI_UNAVAILABLE', 'AI_TRANSIENT', 'INVALID_AI_RESULT', 'AI_INCOMPLETE'].includes(error.code);
const running = new Map();
const now = () => new Date().toISOString();
const safeError = error => ({ code: error instanceof AppError ? error.code : 'EVALUATION_FAILED', message: error instanceof AppError ? error.message : 'No se pudo completar esta evaluación.' });
const readHistory = store => store.readWithConversations ? store.readWithConversations({ fresh: true }) : store.read();

export function eligibleConversations(state, { from, to, country, pendingOnly = true, sourceChangedAfter, includeOpen = state.settings?.includeOpenConversations === true, refreshChanged = state.settings?.refreshChangedConversations === true } = {}) {
  return state.conversations.filter(c => c.messages.length && (includeOpen || c.completed !== false) && (!from || c.date >= from) && (!to || c.date <= to)
    && (!country || c.country === country) && (!pendingOnly || needsEvaluation(state, c, refreshChanged)) && (!sourceChangedAfter || (c.sourceCreatedAt >= sourceChangedAfter || c.sourceUpdatedAt >= sourceChangedAfter || (refreshChanged && !!currentEvaluation(state, c)?.sourceHash && needsEvaluation(state, c, true)))));
}

function validateCatalog(catalog) {
  const active = catalog.filter(v => v.active);
  if (!active.length || active.some(v => !supportsAiVariable(v) && !supportsCodeVariable(v))) throw new AppError(422, 'El checklist activo incluye variables que aún no admite este evaluador.', 'UNSUPPORTED_VARIABLE');
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
  const registry = asRegistry(evaluator);
  if (!registry.configured) throw new AppError(503, 'Falta configurar un modelo habilitado.', 'AI_NOT_CONFIGURED');
  const state = ensureEvaluationState(await readHistory(store));
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
  const catalog = state.catalog;
  const catalogVersions = catalogReferences(catalog);
  const job = { id: randomUUID(), purpose, status: 'running', scope: options.scheduleDate ? 'daily' : options.conversationIds ? 'recheck' : pendingOnly ? 'pending' : 'period',
    sourceJobId: options.sourceJobId || null, scheduleDate: options.scheduleDate || null, from: options.from || null, to: options.to || null, country: options.country || null,
    total: candidates.length * profiles.length, caseCount: candidates.length, completed: 0, failed: 0, errors: [], conversationIds: candidates.map(c => c.id),
    modelProfiles: profiles, fallback, mode: dual ? 'dual' : 'single', concurrency: Math.min(3, Math.max(1, Number(options.concurrency) || 1)), maintenanceId: options.maintenanceId || null, policyVersion: policy.version, catalogVersions, pendingOnly, demo: !!state.metadata.demo,
    idempotencyKey: options.idempotencyKey || null, requestHash, createdAt: now(), updatedAt: now(), finishedAt: null };
  const tasks = candidates.flatMap(c => {
    const codeResults = catalog.filter(v => v.active && supportsCodeVariable(v)).map(v => ({ ...evaluateCodeVariable(c, v), method: 'Código' }));
    return profiles.map(profile => ({ id: randomUUID(), jobId: job.id, conversationId: c.id,
      profile, fallback, codeResults, context: evaluationContext(c, catalog), status: 'pending', round: 1, evaluationId: null, error: null }));
  });
  await store.transaction(draft => {
    ensureEvaluationState(draft); recoverInterrupted(draft);
    if (draft.settings.evaluationMaintenance && draft.settings.evaluationMaintenance !== options.maintenanceId) throw new AppError(409, 'Se está renovando el histórico de evaluaciones.', 'EVALUATION_MAINTENANCE');
    if (registry.policy(draft).version !== policy.version) throw new AppError(409, 'La política cambió. Vuelve a iniciar la evaluación.', 'VERSION_CONFLICT');
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
        codeResults: catalog.filter(v => v.active && supportsCodeVariable(v)).map(v => ({ ...evaluateCodeVariable(c, v), method: 'Código' })) })) });
  });
  return { job, completion: launch(store, registry, job, catalog, options.onProgress) };
}
function launch(store, registry, job, catalog, onProgress) {
  const completion = processJob(store, registry, job, catalog, onProgress);
  running.set(job.id, completion);
  completion.finally(() => running.delete(job.id)).catch(() => {});
  return completion;
}
async function processJob(store, registry, job, catalog, onProgress) {
  const heartbeat = setInterval(() => store.transaction(s => {
    const current = s.jobs.find(j => j.id === job.id);
    if (current?.status === 'running') current.updatedAt = now();
  }).catch(() => {}), 30000);
  heartbeat.unref();
  try {
    const tasks = (await store.read()).tasks.filter(t => t.jobId === job.id && t.status !== 'completed');
    const cases = [...new Set(tasks.map(t => t.conversationId))];
    const worker = async () => { while (cases.length) { const conversationId = cases.shift();
    for (const task of tasks.filter(t => t.conversationId === conversationId)) {
      let error = null;
      try {
        // Atom may change while a long batch is running. Re-read before each task.
        const fresh = await readHistory(store);
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
    await store.transaction(draft => updateJob(draft, job.id, true));
    return (await store.read()).jobs.find(j => j.id === job.id);
  } finally { clearInterval(heartbeat); }
}
function updateJob(state, id, finished) {
  const job = state.jobs.find(j => j.id === id), tasks = state.tasks.filter(t => t.jobId === id);
  job.completed = tasks.filter(t => t.status === 'completed').length;
  job.failed = tasks.filter(t => t.status === 'failed').length;
  job.errors = tasks.filter(t => t.error).map(t => ({ conversationId: t.conversationId, profileId: t.profile.id, ...t.error }));
  job.updatedAt = now();
  if (finished && tasks.every(t => ['completed', 'failed'].includes(t.status))) { job.status = job.failed ? (job.completed ? 'partial' : 'failed') : 'completed'; job.finishedAt = now(); }
}
async function processTask(store, registry, job, task, conversation, catalog) {
  if (!conversation || task.context.sourceHash !== sourceFingerprint(conversation)) throw new AppError(409, 'El contenido de Atom cambió. Crea una nueva muestra.', 'SOURCE_CHANGED');
  const currentContext = evaluationContext(conversation, catalog);
  if (currentContext.promptHash !== task.context.promptHash || currentContext.rulesVersion !== task.context.rulesVersion) throw new AppError(409, 'Las instrucciones cambiaron. Crea una nueva ejecución.', 'PROMPT_CHANGED');
  const claimed = await store.transaction(s => { const t = s.tasks.find(t => t.id === task.id); if (t.status === 'completed' || t.round !== task.round) return false; t.status = 'running'; t.error = null; return true; });
  if (!claimed) return;
  const aiVariables = catalog.filter(v => v.active && supportsAiVariable(v));
  let answer, effective, lastError;
  for (const snapshot of [task.profile, task.fallback].filter(Boolean)) {
    // Never fall back after a non-technical refusal or a configuration/input error.
    if (lastError && !retryable(lastError)) throw lastError;
    const profile = registry.resolve(snapshot.id, snapshot);
    for (let index = 0; index < 2; index++) {
      const attempt = { id: randomUUID(), jobId: job.id, taskId: task.id, round: task.round, profileId: profile.id,
        provider: profile.provider, requestedModel: profile.model, status: 'running', startedAt: now() };
      await store.transaction(s => s.attempts.push(attempt));
      const started = Date.now();
      try {
        answer = aiVariables.length ? await profile.evaluator.evaluate(conversation, aiVariables) : { results: [], model: null, usage: null };
        if (!Array.isArray(answer.results) || answer.results.length !== aiVariables.length) throw new AppError(502, 'Resultado estructurado incompleto.', 'INVALID_AI_RESULT');
        effective = profile;
        await store.transaction(s => Object.assign(s.attempts.find(a => a.id === attempt.id), { status: 'completed', finishedAt: now(), durationMs: Date.now() - started, actualModel: answer.model || profile.model, usage: answer.usage || null }));
        lastError = null; break;
      } catch (error) {
        lastError = error;
        await store.transaction(s => Object.assign(s.attempts.find(a => a.id === attempt.id), { status: 'failed', finishedAt: now(), durationMs: Date.now() - started, error: safeError(error) }));
        if (!retryable(error)) throw error;
        if (index === 0 && profile.provider !== 'demo') await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    if (answer && !lastError) break;
  }
  if (lastError) throw lastError;
  const evaluation = { id: randomUUID(), conversationId: conversation.id, jobId: job.id, taskId: task.id, purpose: job.purpose,
    createdAt: now(), demo: job.demo, ...task.context, provisional: conversation.completed === false, sourceUpdatedAt: conversation.sourceUpdatedAt || null, profileId: effective.id, provider: effective.provider,
    profileLabel: effective.label, requestedProfileId: task.profile.id, requestedProvider: task.profile.provider, requestedModel: task.profile.model,
    model: answer.model || effective.model, modelConfiguration: registry.snapshot(effective), usedFallback: effective.id !== task.profile.id,
    providerResponseId: answer.responseId || null, usage: answer.usage || null, catalogVersions: job.catalogVersions,
    results: [...answer.results, ...(task.codeResults || catalog.filter(v => v.active && supportsCodeVariable(v)).map(v => ({ ...evaluateCodeVariable(conversation, v), method: 'Código' })))] };
  const fresh = await readHistory(store);
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
      if (job.mode === 'dual' && task.profile.id !== primary?.profile.id && primary?.status === 'failed' && retryable(primary.error || {})) evaluation.contingencyFor = primary.profile;
      const blockedPrimary = job.mode === 'dual' && primary?.status === 'failed' && !retryable(primary.error || {});
      const newer = state.jobs.some(j => j.id !== job.id && j.purpose === 'operational' && j.createdAt > job.createdAt && j.conversationIds.includes(conversation.id));
      if (!blockedPrimary && !newer) {
        if (ref && (job.mode !== 'dual' || anchor?.jobId !== job.id)) ref.evaluationId = evaluation.id;
        else if (!ref) state.operationalRefs.push({ id: conversation.id, evaluationId: evaluation.id });
      }
    }
    Object.assign(current, { status: 'completed', evaluationId: evaluation.id, error: null });
  });
}
export async function resumeEvaluationBatch(store, evaluator, jobId) {
  const registry = asRegistry(evaluator);
  const state = ensureEvaluationState(await readHistory(store));
  const job = state.jobs.find(j => j.id === jobId);
  if (!job || !job.modelProfiles) throw new AppError(404, 'La ejecución no admite reanudación.', 'NOT_FOUND');
  if (state.settings.evaluationMaintenance) throw new AppError(409, 'Se está renovando el histórico de evaluaciones.', 'EVALUATION_MAINTENANCE');
  const catalog = restoreCatalog(state, job.catalogVersions);
  if (digest(catalogReferences(state.catalog)) !== digest(job.catalogVersions)) throw new AppError(409, 'El checklist cambió. Inicia una nueva ejecución.', 'CATALOG_CHANGED');
  if (state.jobs.some(j => j.id !== job.id && j.purpose === 'operational' && j.createdAt > job.createdAt && j.conversationIds.some(id => job.conversationIds.includes(id)))) throw new AppError(409, 'Existe una ejecución operativa posterior. Consulta el resultado vigente.', 'SUPERSEDED_JOB');
  const candidates = job.conversationIds.map(id => state.conversations.find(c => c.id === id)).filter(Boolean);
  const pending = state.tasks.filter(t => t.jobId === jobId && t.status !== 'completed');
  if (!pending.length) throw new AppError(409, 'La ejecución ya está completa.', 'ALREADY_COMPLETED');
  for (const task of pending) {
    const c = candidates.find(c => c.id === task.conversationId);
    if (!c || sourceFingerprint(c) !== task.context.sourceHash) throw new AppError(409, 'Atom cambió. Crea una nueva muestra.', 'SOURCE_CHANGED');
    registry.resolve(task.profile.id, task.profile);
  }
  await store.transaction(s => {
    recoverInterrupted(s);
    if (s.jobs.some(j => j.status === 'running')) throw new AppError(409, 'Ya hay una evaluación en curso.', 'EVALUATION_RUNNING');
    const j = s.jobs.find(j => j.id === jobId); Object.assign(j, { status: 'running', updatedAt: now(), finishedAt: null });
    for (const t of s.tasks.filter(t => t.jobId === jobId && t.status !== 'completed')) { t.status = 'pending'; t.round++; t.error = null; }
  });
  const resumedJob = (await store.read()).jobs.find(j => j.id === jobId);
  return { job: resumedJob, completion: launch(store, registry, resumedJob, catalog) };
}
export async function runEvaluationBatch(store, evaluator, options) { return (await startEvaluationBatch(store, evaluator, options)).completion; }
export async function evaluateConversation(store, evaluator, conversation, catalog, { replace = false } = {}) {
  // Compatibility entry point for callers; the batch service owns persistence and attempts.
  const job = await runEvaluationBatch(store, evaluator, { conversationIds: [conversation.id], pendingOnly: !replace, max: 1 });
  if (job.failed) throw new AppError(502, job.errors[0].message, job.errors[0].code);
  return (await store.read()).evaluations.find(e => e.jobId === job.id);
}
