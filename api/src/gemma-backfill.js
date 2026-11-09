import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AppError } from './errors.js';
import { catalogReferences, digest, evaluationContext } from './evaluation-context.js';
import { supportsAiVariable, validateEvaluation } from './evaluator.js';
import { supportsCodeVariable } from './code-evaluator.js';
import { startEvaluationBatch, resumeEvaluationBatch, recoverEvaluationJobs } from './evaluation-service.js';

const fail = (code, message) => { throw new AppError(409, message, code); };
const contextKeys = ['sourceHash', 'catalogHash', 'promptHash', 'rulesVersion'];
const sameContext = (actual, expected) => contextKeys.every(key => actual?.[key] && actual[key] === expected[key]);
const liveJob = job => ['running', 'queued', 'pending'].includes(job.status);
const bound = (registry, state) => registry.forState ? registry.forState(state) : registry;
const readHistory = store => store.readWithConversations({ fresh: true });
export const MAX_BACKFILL_ROUNDS = 3;
const operator = { name: 'CLI · renovación Gemma autorizada', id: null };

export function gemmaBackfillProfile(state, registry) {
  if (state.metadata?.demo !== false) fail('REAL_MODE_REQUIRED', 'La renovación requiere el origen real de Pulso.');
  const models = bound(registry, state), policy = models.policy(state);
  if (policy.mode !== 'single' || policy.primaryId !== 'gemma-local' || policy.secondaryId != null || policy.fallbackId != null) {
    fail('GEMMA_SINGLE_REQUIRED', 'Configura exclusivamente Gemma como principal, en modo individual y sin respaldo.');
  }
  const profile = models.resolve('gemma-local');
  if (profile.provider !== 'gateway' || profile.demo) fail('GEMMA_LOCAL_REQUIRED', 'La renovación solo permite el perfil local de Gemma.');
  return { models, profile: models.snapshot(profile), policyVersion: policy.version };
}

const immutable = manifest => ({ format: manifest.format, id: manifest.id, createdAt: manifest.createdAt,
  profile: manifest.profile, policyVersion: manifest.policyVersion, catalogVersions: manifest.catalogVersions,
  ...(manifest.selection && typeof manifest.selection === 'object' ? { selection: manifest.selection } : {}),
  ...(manifest.revision ? { revision: manifest.revision } : {}),
  conversations: manifest.conversations });

function activityTime(conversation) {
  const validTime = value => typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? Date.parse(value) : -Infinity;
  const recorded = validTime(conversation.lastActivityAt);
  if (Number.isFinite(recorded)) return recorded;
  return (conversation.messages || []).reduce((latest, message) => Math.max(latest, validTime(message.timestamp)), -Infinity);
}
const localActivityDate = value => {
  if (!Number.isFinite(value)) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Tegucigalpa', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = type => parts.find(value => value.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
export function normalizeGemmaSelection(selection) {
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  if (!selection || !validDate(selection.from) || !validDate(selection.to) || selection.from > selection.to
    || !Number.isInteger(selection.limit) || selection.limit < 1 || selection.limit > 500
    || selection.timezone !== 'America/Tegucigalpa' || selection.basis !== 'last_activity'
    || Object.keys(selection).some(key => !['from', 'to', 'timezone', 'basis', 'limit'].includes(key))) {
    fail('INVALID_BACKFILL_SELECTION', 'Indica un rango de fechas válido y un límite entre 1 y 500, por última actividad en Tegucigalpa.');
  }
  return { from: selection.from, to: selection.to, timezone: 'America/Tegucigalpa', basis: 'last_activity', limit: selection.limit };
}

// Pure planning: no files, settings, inference, or transactions are modified.
export function createGemmaBackfillPlan(state, registry, { maintenanceId = null, createdAt = new Date().toISOString(), selection } = {}) {
  const { profile, policyVersion } = gemmaBackfillProfile(state, registry);
  const scope = selection === undefined ? null : normalizeGemmaSelection(selection);
  let conversations = state.conversations.filter(c => c.messages?.length && (!scope || (() => {
      const date = localActivityDate(activityTime(c)); return date && date >= scope.from && date <= scope.to;
    })()))
    .sort((a, b) => {
      const left = activityTime(a), right = activityTime(b);
      if (left !== right) return left < right ? 1 : -1;
      const aId = String(a.id), bId = String(b.id);
      return bId.localeCompare(aId, 'en', { numeric: true }) || (aId < bId ? 1 : aId > bId ? -1 : 0);
    });
  if (scope) conversations = conversations.slice(0, scope.limit);
  if (!conversations.length || new Set(conversations.map(c => c.id)).size !== conversations.length) fail('INVALID_UNIVERSE', 'El universo debe contener conversaciones distintas con mensajes.');
  const manifest = { format: 2, id: maintenanceId || randomUUID(), createdAt, updatedAt: createdAt,
    status: 'planned', selection: scope || 'Última actividad descendente; mensajes como respaldo; ID descendente en empate',
    profile, policyVersion, catalogVersions: catalogReferences(state.catalog),
    conversations: conversations.map(c => ({ id: c.id, country: c.country ?? null, completedAtSource: c.completed !== false,
      sourceDocumentId: c.sourceDocumentId == null ? null : String(c.sourceDocumentId),
      activityAt: Number.isFinite(activityTime(c)) ? new Date(activityTime(c)).toISOString() : null,
      activityDate: localActivityDate(activityTime(c)),
      messageCount: c.messages.length, ...evaluationContext(c, state.catalog) })), batches: [] };
  manifest.integrityHash = digest(immutable(manifest));
  return manifest;
}

function validateManifest(manifest) {
  if (manifest?.selection && typeof manifest.selection === 'object') normalizeGemmaSelection(manifest.selection);
  if (manifest?.format !== 2 || !/^[a-f0-9-]{36}$/.test(manifest.id || '') || !manifest.conversations?.length
    || new Set(manifest.conversations.map(c => c.id)).size !== manifest.conversations.length
    || !Array.isArray(manifest.batches) || digest(immutable(manifest)) !== manifest.integrityHash) {
    fail('INVALID_BACKFILL_MANIFEST', 'El manifiesto de renovación falta, cambió o pertenece al formato anterior. No se modifica el histórico.');
  }
  const ids = new Set(manifest.conversations.map(c => c.id)), reserved = new Set(), keys = new Set();
  for (const batch of manifest.batches) {
    if (!/^[a-f0-9-]{36}$/.test(batch.idempotencyKey || '') || keys.has(batch.idempotencyKey)
      || !Array.isArray(batch.conversationIds) || !batch.conversationIds.length || batch.conversationIds.length > 20
      || batch.conversationIds.some(id => !ids.has(id) || reserved.has(id)) || new Set(batch.conversationIds).size !== batch.conversationIds.length) {
      fail('INVALID_BACKFILL_MANIFEST', 'Los lotes del manifiesto no corresponden a su universo único.');
    }
    keys.add(batch.idempotencyKey); batch.conversationIds.forEach(id => reserved.add(id));
  }
}

// An explicit new scope creates an audited successor. Existing tasks, results,
// contexts and retry limits remain untouched; this function has no side effects.
export function extendGemmaBackfillPlan(state, registry, manifest, { expectedTotal, selection, extendedAt = new Date().toISOString() }) {
  assertGemmaBackfillState(state, registry, manifest);
  if (state.jobs.some(liveJob) || state.tasks.some(t => t.status === 'running') || state.attempts.some(a => a.status === 'running')) fail('EVALUATION_RUNNING', 'Espera a que finalice el trabajador actual antes de ampliar la muestra.');
  const scope = normalizeGemmaSelection(selection);
  if (!Number.isInteger(expectedTotal) || expectedTotal < 1 || manifest.conversations.length !== expectedTotal) fail('BACKFILL_TOTAL_CHANGED', 'El total del manifiesto cambió. No se amplió la muestra.');
  if (scope.limit <= expectedTotal) fail('INVALID_BACKFILL_SELECTION', 'La ampliación debe solicitar más conversaciones que la muestra actual.');
  if (!manifest.selection || typeof manifest.selection !== 'object' || scope.from > manifest.selection.from || scope.to < manifest.selection.to
    || ['timezone', 'basis'].some(key => scope[key] !== manifest.selection[key])) fail('BACKFILL_RANGE_CHANGED', 'La ampliación debe incluir el período anterior y conservar el criterio de actividad.');
  const asOf = Date.parse(extendedAt);
  if (!Number.isFinite(asOf)) fail('INVALID_BACKFILL_SELECTION', 'La fecha de la ampliación no es válida.');
  const source = { ...state, conversations: state.conversations.filter(c => activityTime(c) <= asOf) };
  const planned = createGemmaBackfillPlan(source, registry, { maintenanceId: manifest.id, selection: scope, createdAt: manifest.createdAt });
  if (planned.conversations.length !== scope.limit) fail('INSUFFICIENT_CONVERSATIONS', 'No hay suficientes conversaciones en el período para completar el total solicitado.');
  const selected = new Map(planned.conversations.map(c => [c.id, c]));
  for (const previous of manifest.conversations) {
    const current = selected.get(previous.id);
    if (!current) fail('PREVIOUS_CASE_OUTSIDE_SELECTION', 'Una conversación anterior ya no pertenece a las últimas del período. No se sustituyó la muestra.');
    if (!sameContext(current, previous)) fail('SOURCE_CHANGED', 'Cambió una conversación anterior. Conserva su evaluación y revisa el cambio antes de ampliar.');
  }
  const inspection = inspectGemmaBackfill(state, manifest);
  if (inspection.invalid || inspection.changed || inspection.missing) fail('STORED_RESULT_INVALID', 'La muestra anterior contiene resultados inválidos o contenido cambiado. No se amplió.');
  const previousCases = new Map(manifest.conversations.map(c => [c.id, c]));
  const next = { ...structuredClone(manifest), selection: scope,
    conversations: planned.conversations.map(c => structuredClone(previousCases.get(c.id) || c)),
    revision: { number: (manifest.revision?.number || 1) + 1, parentIntegrityHash: manifest.integrityHash,
      extendedAt, activityAsOf: extendedAt, previousTotal: expectedTotal, requestedTotal: scope.limit,
      reusedCompleted: inspection.completed, retainedPending: inspection.pending },
    status: 'planned', updatedAt: extendedAt };
  delete next.summary; delete next.lastError;
  next.integrityHash = digest(immutable(next));
  validateManifest(next);
  return next;
}

export function assertGemmaBackfillState(state, registry, manifest, { completed = false } = {}) {
  validateManifest(manifest);
  const { models, profile, policyVersion } = gemmaBackfillProfile(state, registry);
  if (state.settings.dailyEnabled) fail('DAILY_MUST_BE_PAUSED', 'La programación diaria debe permanecer pausada durante la renovación.');
  if (state.settings.evaluationMaintenance !== manifest.id
    && !(completed && state.settings.evaluationMaintenance == null && state.settings.lastBackfillId === manifest.id)) {
    fail('BACKFILL_MAINTENANCE_REQUIRED', 'La renovación requiere el mantenimiento exacto de un reinicio respaldado.');
  }
  if (policyVersion !== manifest.policyVersion) fail('POLICY_CHANGED', 'La política cambió después de preparar la renovación.');
  models.resolve(manifest.profile.id, manifest.profile);
  if (profile.model !== manifest.profile.model || profile.provider !== manifest.profile.provider) fail('MODEL_CHANGED', 'El modelo de la renovación cambió.');
  const current = evaluationContext({ id: 'context-only', messages: [] }, state.catalog);
  if (digest(catalogReferences(state.catalog)) !== digest(manifest.catalogVersions)) fail('CATALOG_CHANGED', 'El checklist cambió después de fijar el universo.');
  if (manifest.conversations.some(c => c.catalogHash !== current.catalogHash || c.promptHash !== current.promptHash || c.rulesVersion !== current.rulesVersion)) {
    fail('PROMPT_CHANGED', 'Las instrucciones o reglas cambiaron después de fijar el universo.');
  }
  const keys = new Set(manifest.batches.map(batch => batch.idempotencyKey));
  const foreign = (state.jobs || []).filter(job => job.maintenanceId !== manifest.id || !keys.has(job.idempotencyKey));
  if (foreign.length) fail('FOREIGN_BACKFILL_JOB', 'Hay ejecuciones ajenas a este manifiesto; se requiere revisión antes de continuar.');
}

function validEvaluation(evaluation, task, job, expected, manifest, conversation, catalog) {
  if (!evaluation || task.status !== 'completed' || task.error || evaluation.partial !== false || evaluation.validationErrors?.length
    || evaluation.taskId !== task.id || evaluation.jobId !== job.id || evaluation.purpose !== 'operational'
    || evaluation.conversationId !== expected.id || evaluation.provider !== 'gateway' || evaluation.usedFallback
    || evaluation.profileId !== 'gemma-local' || evaluation.requestedProfileId !== 'gemma-local'
    || evaluation.model !== manifest.profile.model || evaluation.modelConfiguration?.configurationHash !== manifest.profile.configurationHash
    || !sameContext(evaluation, expected) || !sameContext(task.context, expected)
    || digest(catalogReferences(evaluation.catalogVersions || [])) !== digest(catalogReferences(manifest.catalogVersions))
    || !Array.isArray(evaluation.results)) return false;
  const variables = catalog.filter(v => v.active && !v.retired && (supportsAiVariable(v) || supportsCodeVariable(v)));
  if (evaluation.results.length !== variables.length || new Set(evaluation.results.map(r => r.variableId)).size !== variables.length) return false;
  const resultMap = new Map(evaluation.results.map(r => [r.variableId, r]));
  const aiVariables = variables.filter(supportsAiVariable);
  try {
    validateEvaluation({ results: Object.fromEntries(aiVariables.map(variable => {
      const result = resultMap.get(variable.id), original = result?.aiResult || result;
      return [variable.id, { status: original?.status, value: original?.value, reason: original?.reason,
        evidence_message_ids: Array.isArray(original?.evidence) ? original.evidence.map(e => e.messageId) : null }];
    })) }, aiVariables, conversation);
  } catch { return false; }
  for (const variable of variables) {
    const result = resultMap.get(variable.id);
    if (!result || result.error || !Array.isArray(result.evidence) || !['evaluado', 'no_evaluado'].includes(result.status)
      || typeof result.reason !== 'string' || !result.reason.trim()) return false;
    if (!supportsAiVariable(variable) && (result.status === 'no_evaluado' ? result.value !== null
      : variable.type === 'Métrica' ? typeof result.value !== 'number' || !Number.isFinite(result.value)
      : ![0, 1].includes(result.value))) return false;
  }
  return true;
}

// Only task-linked, complete, equivalent Gemma results count. Abstentions with
// valid context remain legitimate results; technical no_evaluado placeholders do not.
export function inspectGemmaBackfill(state, manifest) {
  validateManifest(manifest);
  const conversations = new Map(state.conversations.map(c => [c.id, c]));
  const byEvaluation = new Map(state.evaluations.map(e => [e.id, e]));
  const batches = new Map(manifest.batches.map(b => [b.idempotencyKey, b]));
  const jobs = state.jobs.filter(j => j.maintenanceId === manifest.id && batches.has(j.idempotencyKey));
  const byConversation = new Map();
  for (const job of jobs) for (const task of state.tasks.filter(t => t.jobId === job.id)) {
    if (byConversation.has(task.conversationId)) fail('DUPLICATE_BACKFILL_TASK', 'Una conversación tiene varias tareas en el mismo manifiesto.');
    byConversation.set(task.conversationId, { task, job });
  }
  const cases = manifest.conversations.map(expected => {
    const conversation = conversations.get(expected.id), current = byConversation.get(expected.id);
    const base = { id: expected.id, jobId: current?.job.id || null, taskId: current?.task.id || null,
      round: current?.task.round || 0, evaluationId: current?.task.evaluationId || null };
    if (!conversation?.messages.length) return { ...base, status: 'missing', code: 'SOURCE_MISSING' };
    if (!sameContext(evaluationContext(conversation, state.catalog), expected)) return { ...base, status: 'changed', code: 'SOURCE_CHANGED' };
    if (!current) return { ...base, status: 'unstarted' };
    const { task, job } = current;
    if (job.purpose !== 'operational' || job.mode !== 'single' || job.fallback || job.modelProfiles?.length !== 1
      || job.modelProfiles[0].configurationHash !== manifest.profile.configurationHash || task.profile.id !== 'gemma-local'
      || task.profile.configurationHash !== manifest.profile.configurationHash || task.fallback) return { ...base, status: 'invalid', code: 'RESULT_IDENTITY_MISMATCH' };
    if (task.status === 'completed') {
      const valid = validEvaluation(byEvaluation.get(task.evaluationId), task, job, expected, manifest, conversation, state.catalog);
      return { ...base, status: valid ? 'completed' : 'invalid', code: valid ? null : 'STORED_RESULT_INVALID' };
    }
    return { ...base, status: task.status, code: task.error?.code || null };
  });
  const count = status => cases.filter(c => c.status === status).length;
  return { total: cases.length, completed: count('completed'), partial: count('partial'), failed: count('failed'),
    changed: count('changed'), missing: count('missing'), invalid: count('invalid'), unstarted: count('unstarted'),
    pending: cases.filter(c => c.status !== 'completed').length, cases };
}

function guardedBackfillStore(store, registry, manifest, ids) {
  let firstHistoryRead = true;
  return {
    async read() { const state = await store.read(); assertGemmaBackfillState(state, registry, manifest); return state; },
    async readWithConversations(options) {
      const state = await store.readWithConversations(options);
      assertGemmaBackfillState(state, registry, manifest);
      // Bind the job's original task contexts to the frozen manifest, even if
      // Atom changed between orchestration and startEvaluationBatch's own read.
      if (firstHistoryRead) {
        firstHistoryRead = false;
        for (const id of ids) {
          const conversation = state.conversations.find(c => c.id === id);
          const expected = manifest.conversations.find(c => c.id === id);
          if (!conversation || !sameContext(evaluationContext(conversation, state.catalog), expected)) fail('SOURCE_CHANGED', 'El contenido cambió antes de iniciar el lote; queda pendiente sin sustituir la muestra.');
        }
      }
      return state;
    },
    transaction(fn) { return store.transaction(state => { assertGemmaBackfillState(state, registry, manifest); return fn(state); }); },
  };
}

export async function executeGemmaBackfill(store, registry, manifest, { resume = false, maxBatches = Infinity,
  checkpoint = async () => {}, onProgress = async () => {} } = {}) {
  let state = await readHistory(store);
  assertGemmaBackfillState(state, registry, manifest, { completed: true });
  let summary = inspectGemmaBackfill(state, manifest);
  if (state.settings.evaluationMaintenance == null) {
    if (summary.pending) fail('BACKFILL_INCOMPLETE', 'La renovación cerrada tiene resultados pendientes; se requiere revisión.');
    return { ...summary, status: 'completed', dailyEnabled: false, maintenanceReleased: true };
  }
  if (state.jobs.some(liveJob)) {
    // Explicit resumption may recover only stale jobs belonging to this manifest.
    if (!resume || state.jobs.some(j => liveJob(j) && (j.status !== 'running' || Date.parse(j.updatedAt || j.createdAt) >= Date.now() - 10 * 60_000))) {
      fail('EVALUATION_RUNNING', 'Hay una ejecución activa. No se inicia otra ni se fuerza su cierre.');
    }
    await recoverEvaluationJobs(store);
    state = await readHistory(store);
  }
  if ((state.jobs.length || manifest.batches.length) && !resume) fail('BACKFILL_RESUME_REQUIRED', 'Usa --execute --resume con el mismo mantenimiento para continuar.');
  if (!manifest.batches.length && ['evaluations', 'tasks', 'operationalRefs'].some(key => state[key]?.length)) fail('BACKFILL_RESET_REQUIRED', 'El inicio requiere tablas de evaluación vacías tras el respaldo y reinicio.');
  for (const batch of manifest.batches) {
    const job = state.jobs.find(j => j.idempotencyKey === batch.idempotencyKey);
    if (job) batch.jobId = job.id;
  }
  let dispatches = 0;
  const attempted = new Set();
  manifest.status = 'running';
  const save = async () => { manifest.updatedAt = new Date().toISOString(); await checkpoint(manifest); };
  await save();
  while (dispatches < maxBatches) {
    state = await readHistory(store);
    assertGemmaBackfillState(state, registry, manifest);
    if (state.jobs.some(liveJob)) fail('EVALUATION_RUNNING', 'Hay una ejecución activa; se conserva el mantenimiento.');
    summary = inspectGemmaBackfill(state, manifest);
    if (summary.invalid) fail('STORED_RESULT_INVALID', 'Una tarea completa tiene resultados inválidos o no equivalentes. No se cuenta como terminada.');
    let batch, existing, selectedIds;
    for (const candidate of manifest.batches) {
      const job = state.jobs.find(j => j.idempotencyKey === candidate.idempotencyKey);
      const cases = summary.cases.filter(c => candidate.conversationIds.includes(c.id));
      const unfinished = cases.filter(c => c.status !== 'completed');
      const eligible = unfinished.filter(c => !['changed', 'missing'].includes(c.status)
        && c.round < MAX_BACKFILL_ROUNDS && !['AI_CONFIGURATION', 'AI_REJECTED', 'AI_SAFETY_REFUSAL'].includes(c.code));
      if (!eligible.length || attempted.has(`${candidate.idempotencyKey}:${eligible.map(c => `${c.id}@${c.round}`).join(',')}`)) continue;
      batch = candidate; existing = job; selectedIds = eligible.map(c => c.id);
      if (!job && selectedIds.length !== candidate.conversationIds.length) {
        // No database job has consumed this key yet. Release changed IDs from
        // its reservation; their frozen universe entries remain pending.
        batch.conversationIds = selectedIds;
        await save();
      }
      break;
    }
    if (!batch) {
      const reserved = new Set(manifest.batches.flatMap(b => b.conversationIds));
      const ids = summary.cases.filter(c => c.status === 'unstarted' && !reserved.has(c.id)).slice(0, 20).map(c => c.id);
      if (!ids.length) break;
      batch = { idempotencyKey: randomUUID(), conversationIds: ids, jobId: null, createdAt: new Date().toISOString() };
      selectedIds = ids;
      manifest.batches.push(batch);
      await save(); // Durable key precedes every possible provider call.
    }
    const cases = summary.cases.filter(c => selectedIds.includes(c.id));
    attempted.add(`${batch.idempotencyKey}:${cases.map(c => `${c.id}@${c.round}`).join(',')}`);
    const guardedStore = guardedBackfillStore(store, registry, manifest, selectedIds);
    const launch = existing ? await resumeEvaluationBatch(guardedStore, registry, existing.id, { conversationIds: selectedIds })
      : await startEvaluationBatch(guardedStore, registry, { conversationIds: batch.conversationIds, pendingOnly: false,
        includeOpen: true, max: batch.conversationIds.length, concurrency: 1, purpose: 'operational',
        maintenanceId: manifest.id, idempotencyKey: batch.idempotencyKey, author: operator });
    batch.jobId = launch.job.id;
    try { await save(); } catch (error) { await launch.completion; throw error; }
    await launch.completion;
    dispatches++;
    state = await readHistory(store);
    assertGemmaBackfillState(state, registry, manifest);
    summary = inspectGemmaBackfill(state, manifest);
    const job = state.jobs.find(j => j.id === batch.jobId);
    batch.status = job.status;
    manifest.summary = summary;
    await save();
    await onProgress({ jobId: job.id, total: summary.total, completed: summary.completed, pending: summary.pending,
      jobCompleted: job.completed, jobFailed: job.failed, dispatches });
    if (job.errors.some(e => ['AI_CONFIGURATION', 'AI_REJECTED', 'AI_SAFETY_REFUSAL'].includes(e.code))) {
      manifest.status = 'blocked'; await save();
      fail('BACKFILL_PROVIDER_BLOCKED', 'El proveedor requiere intervención. Se guardó el avance y no se inició otro lote.');
    }
  }
  state = await readHistory(store);
  assertGemmaBackfillState(state, registry, manifest);
  summary = inspectGemmaBackfill(state, manifest);
  manifest.summary = summary;
  manifest.status = summary.pending ? 'partial' : 'completed';
  await save();
  if (!summary.pending) {
    await store.transaction(draft => {
      assertGemmaBackfillState(draft, registry, manifest);
      if (draft.jobs.some(liveJob) || inspectGemmaBackfill({ ...draft, conversations: state.conversations }, manifest).pending) {
        fail('BACKFILL_STATE_CHANGED', 'El estado cambió antes de cerrar la renovación.');
      }
      draft.settings = { ...draft.settings, evaluationMaintenance: null, dailyEnabled: false,
        resetPreviousDailyEnabled: undefined, lastBackfillId: manifest.id, lastBackfillCompletedAt: manifest.updatedAt,
        version: draft.settings.version + 1 };
    });
  }
  return { ...summary, status: manifest.status, dailyEnabled: false, maintenanceReleased: !summary.pending };
}

export async function readRequiredBackfillManifest(filename) {
  try {
    const manifest = JSON.parse(await readFile(filename, 'utf8'));
    validateManifest(manifest);
    return manifest;
  } catch (error) {
    if (error.code === 'ENOENT') fail('BACKFILL_MANIFEST_REQUIRED', 'Falta el manifiesto de la selección autorizada. Recupera el manifiesto preparado; no se generará otro universo.');
    throw error;
  }
}

export async function persistBackfillManifest(filename, manifest) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(manifest, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

// Never automatically remove a stale lock: a process on another host or a slow
// worker may still own it. An operator must verify termination before removal.
export async function acquireBackfillLock(filename, maintenanceId) {
  const token = randomUUID();
  let handle;
  try { handle = await open(filename, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('BACKFILL_LOCKED', 'Ya existe el bloqueo de esta renovación. Comprueba que su proceso terminó antes de retirar un bloqueo abandonado.'); throw error; }
  try { await handle.writeFile(JSON.stringify({ token, maintenanceId, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() })); await handle.sync(); }
  finally { await handle.close(); }
  return async () => {
    const current = JSON.parse(await readFile(filename, 'utf8'));
    if (current.token !== token) fail('BACKFILL_LOCK_CHANGED', 'El bloqueo de la renovación cambió; no se elimina.');
    await unlink(filename);
  };
}
