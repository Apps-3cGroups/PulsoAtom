import { catalogV5 } from './catalog-v5.js';
import { conversationView, viewContext } from './domain.js';
import { AppError } from './errors.js';

const terminal = ['completed', 'partial', 'failed'];
const fail = code => { throw new AppError(409, 'No se pudo verificar el alcance del diagnóstico. No se modificaron datos.', code); };

// Read-only diagnostics: whitelist every output field. Never expose provider
// messages, raw responses, variable reasons, conversation IDs or client data.
const auditErrorCodes = new Set(['AI_UNAVAILABLE', 'AI_TRANSIENT', 'AI_CONTEXT_LIMIT', 'AI_CONFIGURATION',
  'INVALID_AI_RESULT', 'AI_INCOMPLETE', 'AI_SAFETY_REFUSAL', 'INPUT_CAPACITY_EXCEEDED', 'UNSUPPORTED_INPUT',
  'SOURCE_CHANGED', 'CATALOG_CHANGED', 'MODEL_CHANGED', 'PROMPT_CHANGED', 'EVALUATION_FAILED',
  'MODEL_IDENTITY_UNVERIFIED', 'INVALID_MODEL_PROVENANCE', 'NATIVE_SCHEMA_MISMATCH', 'NATIVE_MODEL_MISMATCH']);
const auditVariableIds = new Set(catalogV5.map(v => v.id));
const auditValidationRules = new Set(['missing_item', 'invalid_status', 'invalid_value_type', 'invalid_reason', 'invalid_evidence_count',
  'unknown_evidence_message', 'missing_evidence', 'unexpected_evidence', 'inconsistent_status_value', 'unexpected_fields']);
const auditErrors = rows => {
  const counts = new Map();
  for (const row of rows) if (row.error) {
    const key = auditErrorCodes.has(row.error.code) ? row.error.code : 'OTHER';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
};
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const iso = value => value === null ? null : new Date(value).toISOString();
const auditProfileMatches = (a, b) => !!a && !!b && ['id', 'provider', 'model', 'configurationHash', 'protocol',
  'outputSchemaVersion', 'decisionInstructionsVersion', 'adapterVersion', 'instructionsHash'].every(key => (a[key] ?? null) === (b[key] ?? null));

export function evaluationBatchAudit(state, { jobId = null, conversationIds, profiles }, observedAt = new Date().toISOString()) {
  if (!Array.isArray(conversationIds) || !conversationIds.length || conversationIds.some(id => typeof id !== 'string' || !id)
    || new Set(conversationIds).size !== conversationIds.length || !Array.isArray(profiles) || profiles.length !== 2
    || profiles.some(p => !p || typeof p.id !== 'string' || !/^[a-z][a-z0-9_-]{0,159}$/.test(p.id))
    || new Set(profiles.map(p => p.id)).size !== 2 || new Set(profiles.map(p => JSON.stringify([p.provider, p.model]))).size !== 2) fail('AUDIT_SCOPE_MISMATCH');
  const total = conversationIds.length, modelIds = profiles.map(p => p.id);
  const observed = timestamp(observedAt);
  if (observed === null) fail('INVALID_AUDIT_TIME');
  const jobs = state.jobs.filter(j => j.id === jobId);
  if (jobs.length > 1) fail('DUPLICATE_BATCH');
  if (jobId !== null && !jobs.length) fail('AUDIT_JOB_NOT_FOUND');
  const job = jobs[0], ids = new Set(conversationIds);
  const tasks = job ? state.tasks.filter(t => t.jobId === job.id) : [];
  if (job && (job.mode !== 'dual' || job.purpose !== 'operational'
    || job.conversationIds?.length !== total || new Set(job.conversationIds).size !== total || job.conversationIds.some(id => !ids.has(id))
    || job.modelProfiles?.length !== 2 || job.modelProfiles.some((p, i) => !auditProfileMatches(p, profiles[i]))
    || tasks.length !== total * 2 || new Set(tasks.map(t => JSON.stringify([t.conversationId, t.profile?.id]))).size !== total * 2
    || new Set(tasks.map(t => t.id)).size !== total * 2
    || tasks.some(t => !ids.has(t.conversationId) || !modelIds.includes(t.profile?.id)
      || !auditProfileMatches(t.profile, profiles.find(p => p.id === t.profile.id))))) fail('AUDIT_SCOPE_MISMATCH');
  const referencedIds = new Set(tasks.map(t => t.evaluationId).filter(Boolean));
  const referenced = state.evaluations.filter(e => referencedIds.has(e.id));
  if (new Set(referenced.map(e => e.id)).size !== referenced.length) fail('AUDIT_RESULT_MISMATCH');
  const evaluationById = new Map(referenced.map(e => [e.id, e]));
  const saved = tasks.filter(t => t.evaluationId).map(t => {
    const evaluation = evaluationById.get(t.evaluationId);
    if (!evaluation || evaluation.jobId !== job.id || evaluation.taskId !== t.id || evaluation.conversationId !== t.conversationId
      || evaluation.profileId !== t.profile.id || evaluation.usedFallback
      || !auditProfileMatches(evaluation.modelConfiguration, t.profile)
      || !Array.isArray(evaluation.catalogVersions) || new Set(evaluation.catalogVersions.map(ref => ref.id)).size !== evaluation.catalogVersions.length
      || !Array.isArray(evaluation.results) || new Set(evaluation.results.map(r => r.variableId)).size !== evaluation.results.length) fail('AUDIT_RESULT_MISMATCH');
    return { task: t, evaluation };
  });
  const source = state.conversations.filter(c => ids.has(c.id));
  if (new Set(source.map(c => c.id)).size !== source.length) fail('AUDIT_SOURCE_DUPLICATE');
  // Pin coverage to this cohort even if a newer operational job was run later.
  // This copy is in memory only; saved references and results remain untouched.
  const scoped = { ...state, conversations: source.map(c => ({ ...c, evaluationId: null })),
    operationalRefs: source.map(c => ({ id: c.id, evaluationId: saved.find(s => s.task.conversationId === c.id)?.evaluation.id || null })) };
  const context = viewContext(scoped), views = scoped.conversations.map(c => conversationView(scoped, c, context));
  const sourceMissing = total - views.length;
  const coverage = { total, sourceMissing,
    evaluated: views.filter(v => v.evaluationStatus === 'evaluated').length,
    reviewPending: views.filter(v => v.evaluationStatus === 'review_pending').length,
    partial: views.filter(v => v.evaluationStatus === 'partial').length,
    notEvaluated: views.filter(v => v.evaluationStatus === 'not_evaluated').length + sourceMissing,
    sourceChanged: views.filter(v => v.sourceChanged).length,
    withSavedResults: views.filter(v => v.evaluated).length };
  const agreed = Object.fromEntries(['critical', 'normal', 'positive'].map(classification => {
    const counts = views.map(v => v.marks.filter(m => m.effective && m.dualDetected && m.classification === classification).length);
    return [classification, { flags: counts.reduce((n, count) => n + count, 0), conversations: counts.filter(Boolean).length }];
  }));
  agreed.conversations = views.filter(v => v.marks.some(m => m.effective && m.dualDetected)).length;
  agreed.attentionConversations = views.filter(v => v.marks.some(m => m.effective && m.dualDetected && ['critical', 'normal'].includes(m.classification))).length;
  const definitions = new Map(state.catalogVersions.map(v => [v.id, v.snapshot]));
  const models = modelIds.map(profileId => {
    const selected = tasks.filter(t => t.profile.id === profileId), taskIds = new Set(selected.map(t => t.id));
    const attempts = state.attempts.filter(a => a.jobId === job?.id && taskIds.has(a.taskId) && a.profileId === profileId);
    const evaluations = saved.filter(s => s.task.profile.id === profileId).map(s => s.evaluation);
    const results = evaluations.flatMap(e => e.catalogVersions.filter(ref => ref.active).flatMap(ref => {
      const definition = definitions.get(`${ref.id}:${ref.version}`);
      if (!definition) fail('MISSING_CATALOG_VERSION');
      return ['IA', 'IA + código'].includes(definition.method) ? e.results.filter(r => r.variableId === ref.id) : [];
    }));
    const expectedResults = evaluations.reduce((n, e) => n + e.catalogVersions.filter(ref => ref.active
      && ['IA', 'IA + código'].includes(definitions.get(`${ref.id}:${ref.version}`)?.method)).length, 0);
    const starts = attempts.map(a => timestamp(a.startedAt)).filter(t => t !== null);
    const finishes = attempts.map(a => timestamp(a.finishedAt)).filter(t => t !== null);
    const firstStarted = starts.length ? Math.min(...starts) : null, lastFinished = finishes.length ? Math.max(...finishes) : null;
    const finished = selected.length === total && selected.every(t => terminal.includes(t.status));
    const count = status => selected.filter(t => t.status === status).length;
    const variableErrors = new Map(), validationRules = new Map();
    for (const result of results.filter(r => r.error)) {
      if (auditVariableIds.has(result.variableId)) variableErrors.set(result.variableId, (variableErrors.get(result.variableId) || 0) + 1);
      for (const rule of new Set(Array.isArray(result.error.rules) ? result.error.rules : [])) {
        const key = auditValidationRules.has(rule) ? rule : 'OTHER';
        validationRules.set(key, (validationRules.get(key) || 0) + 1);
      }
    }
    const top = counts => [...counts.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, 5).map(([key, count]) => ({ key, count }));
    return { profileId, total, completed: count('completed'), partial: count('partial'), failed: count('failed'), running: count('running'),
      pending: job ? selected.filter(t => ![...terminal, 'running'].includes(t.status)).length : total,
      savedEvaluations: evaluations.length, firstStartedAt: iso(firstStarted), lastFinishedAt: iso(lastFinished),
      finishedAt: finished ? iso(lastFinished) : null,
      elapsedSeconds: firstStarted === null || (finished && lastFinished === null) ? null : Math.max(0, Math.round(((finished ? lastFinished : observed) - firstStarted) / 1000)),
      attemptCount: attempts.length, activeAttempts: attempts.filter(a => a.status === 'running').length,
      invalidAttemptTimestamps: attempts.filter(a => timestamp(a.startedAt) === null || (a.finishedAt != null && timestamp(a.finishedAt) === null)).length,
      taskErrors: auditErrors(selected), attemptErrors: auditErrors(attempts),
      aiResults: { expectedInSavedEvaluations: expectedResults, saved: results.length,
        evaluated: results.filter(r => r.status === 'evaluado' && !r.error).length,
        abstained: results.filter(r => r.status === 'no_evaluado' && r.value === null && !r.error && !r.unavailabilityCode).length,
        unavailable: results.filter(r => r.status === 'no_evaluado' && r.value === null && !r.error && !!r.unavailabilityCode).length,
        technicalErrors: results.filter(r => r.error).length, missing: expectedResults - results.length,
        errorCodes: auditErrors(results), topErrorVariables: top(variableErrors), topValidationRules: top(validationRules) } };
  });
  return { checkedAt: iso(observed), coverage, agreed, models };
}
