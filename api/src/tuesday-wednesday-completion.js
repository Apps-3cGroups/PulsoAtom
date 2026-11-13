import { AppError } from './errors.js';
import { digest, evaluationContext } from './evaluation-context.js';
import { RECOVERY_ID, RECOVERY_JOBS, recoveryPlan, verifyPreservedResults } from './gemma-incident-recovery.js';

export const COMPLETION_ID = '8fa643d2-0c32-4cbc-88da-14959ff877cd';
export const COMPLETION_MODELS = ['clef-local', 'gemma-local'];
export const COMPLETION_KEYS = { tuesday: `${COMPLETION_ID}:tuesday`, wednesday: `${COMPLETION_ID}:wednesday` };
export const COMPLETION_EXCLUSION_REASON = 'USER_AUTHORIZED_SKIP_PROVIDER_MEMORY';
const contextKeys = ['sourceHash', 'catalogHash', 'promptHash', 'promptVersion', 'rulesVersion'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value ?? null;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const completionFailure = code => { throw new AppError(409, 'La operación se detuvo y conserva los resultados existentes.', code); };
const day = value => Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) - 6 * 3600000).toISOString().slice(0, 10) : null;
const ownJob = job => RECOVERY_JOBS.includes(job.id) || Object.values(COMPLETION_KEYS).includes(job.idempotencyKey);
const immutablePlan = plan => ({ format: plan.format, id: plan.id, createdAt: plan.createdAt, maintenanceId: plan.maintenanceId,
  priorMaintenance: plan.priorMaintenance, profiles: plan.profiles, policyHash: plan.policyHash, catalogHash: plan.catalogHash,
  retry: plan.retry, excluded: plan.excluded, tuesday: plan.tuesday, wednesday: plan.wednesday, protected: plan.protected });

export function assertOriginalIncident(state, incident, workerAlive = false) {
  if (incident?.id !== RECOVERY_ID || incident.plan?.id !== RECOVERY_ID || !['blocked', 'partial', 'completed'].includes(incident.status)
    || workerAlive || state.settings.evaluationMaintenance !== RECOVERY_ID
    || !Array.isArray(incident.plan.completed) || !Object.hasOwn(incident.plan, 'priorMaintenance')
    || [RECOVERY_ID, COMPLETION_ID].includes(incident.plan.priorMaintenance)) completionFailure('INCIDENT_NOT_STOPPED');
  if (state.jobs.some(j => ['running', 'queued', 'pending'].includes(j.status))
    || state.tasks.some(t => t.status === 'running') || state.attempts.some(a => a.status === 'running')) completionFailure('EVALUATION_RUNNING');
  verifyPreservedResults(state, incident.plan);
}

// Selection uses the exact business scope, not an open-ended date/range retry.
export function selectCompletionSources(state) {
  if (new Set(state.conversations.map(c => c.id)).size !== state.conversations.length) completionFailure('DUPLICATE_SOURCE');
  const old = state.tasks.filter(t => RECOVERY_JOBS.includes(t.jobId) && t.status !== 'deferred');
  const retry = old.filter(t => t.status !== 'completed');
  if (old.length !== 728 || retry.length !== 3 || retry.some(t => t.status !== 'partial')
    || new Set(retry.map(t => t.conversationId)).size !== 3) completionFailure('RECOVERY_SCOPE_CHANGED');
  const attempted = new Set([...state.evaluations.map(e => String(e.conversationId)), ...state.tasks.map(t => String(t.conversationId))]);
  const tuesday = state.conversations.filter(c => c.country === 'HN' && day(c.lastActivityAt) === '2026-11-10' && !attempted.has(String(c.id)));
  const wednesday = state.conversations.filter(c => (c.country === 'PA' && String(c.ingestionBatchId) === '236'
    || c.country === 'HN' && String(c.ingestionBatchId) === '237') && day(c.startedAt) === '2026-11-11');
  const sources = retry.map(t => state.conversations.find(c => c.id === t.conversationId));
  if (sources.some(c => !c || day(c.lastActivityAt) !== '2026-11-10')
    || sources.filter(c => c?.country === 'HN').length !== 2 || sources.filter(c => c?.country === 'PA').length !== 1
    || tuesday.length !== 167 || wednesday.length !== 43 || wednesday.filter(c => c.country === 'HN').length !== 20
    || wednesday.filter(c => c.country === 'PA').length !== 23 || wednesday.some(c => attempted.has(String(c.id)))) completionFailure('AUTHORIZED_SCOPE_CHANGED');
  const sort = values => [...values].sort((a, b) => Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
  return { retry, tuesday: sort(tuesday), wednesday: sort(wednesday) };
}

export function makeCompletionPlan(state, registry, incident, timestamp = new Date().toISOString()) {
  if (state.metadata?.demo !== false) completionFailure('REAL_MODE_REQUIRED');
  assertOriginalIncident(state, incident);
  const selected = selectCompletionSources(state), bound = registry.forState(state);
  const profiles = COMPLETION_MODELS.map(id => bound.snapshot(bound.resolve(id)));
  if (profiles.some(p => p.provider !== 'gateway' || p.demo) || new Set(profiles.map(p => p.model)).size !== 2) completionFailure('LOCAL_MODELS_REQUIRED');
  const freeze = c => {
    if (!c.messages?.length) completionFailure('SOURCE_NOT_HYDRATED');
    return { id: c.id, country: c.country, activityDay: day(c.lastActivityAt), startedDay: day(c.startedAt),
      ingestionBatchId: c.ingestionBatchId ?? null, ...evaluationContext(c, state.catalog) };
  };
  const retry = selected.retry.map(task => {
    bound.resolve(task.profile.id, task.profile);
    const source = freeze(state.conversations.find(c => c.id === task.conversationId));
    if (contextKeys.some(key => source[key] !== task.context[key])) completionFailure('SOURCE_CHANGED');
    return { ...source, taskId: task.id, jobId: task.jobId, profileId: task.profile.id };
  });
  const recovery = recoveryPlan(state);
  const excludedTasks = selected.retry.filter(task => task.profile.id === 'clef-local');
  if (excludedTasks.length !== 1) completionFailure('EXCLUSION_SCOPE_CHANGED');
  const excluded = excludedTasks.map(task => {
    const evaluation = state.evaluations.find(row => row.id === task.evaluationId);
    if (!evaluation) completionFailure('EXCLUSION_SCOPE_CHANGED');
    return { id: task.conversationId, taskId: task.id, profileId: task.profile.id, reason: COMPLETION_EXCLUSION_REASON,
      taskHash: digest(task), evaluationId: evaluation.id, evaluationHash: digest(evaluation) };
  });
  const plan = { format: 1, id: COMPLETION_ID, createdAt: timestamp, maintenanceId: RECOVERY_ID,
    priorMaintenance: incident.plan.priorMaintenance, profiles, policyHash: digest(state.settings.aiPolicy), catalogHash: digest(state.catalog),
    retry, excluded, tuesday: selected.tuesday.map(freeze), wednesday: selected.wednesday.map(freeze),
    protected: recovery.completed };
  plan.integrityHash = digest(immutablePlan(plan));
  return plan;
}

export function assertCompletionPlan(plan) {
  const all = [...(plan?.retry || []), ...(plan?.tuesday || []), ...(plan?.wednesday || [])];
  if (plan?.format !== 1 || plan.id !== COMPLETION_ID || plan.maintenanceId !== RECOVERY_ID
    || plan.retry?.length !== 3 || plan.tuesday?.length !== 167 || plan.wednesday?.length !== 43
    || all.length !== 213 || new Set(all.map(c => c.id)).size !== 213 || plan.protected?.length !== 725
    || plan.profiles?.length !== 2 || !COMPLETION_MODELS.every((id, i) => plan.profiles[i].id === id)
    || plan.excluded?.length !== 1 || plan.excluded[0].profileId !== 'clef-local' || plan.excluded[0].reason !== COMPLETION_EXCLUSION_REASON
    || !plan.retry.some(task => task.id === plan.excluded[0].id && task.taskId === plan.excluded[0].taskId && task.profileId === 'clef-local')
    || [RECOVERY_ID, COMPLETION_ID].includes(plan.priorMaintenance)
    || digest(immutablePlan(plan)) !== plan.integrityHash) completionFailure('INVALID_COMPLETION_MANIFEST');
}
export const completionSources = plan => [...plan.retry, ...plan.tuesday, ...plan.wednesday];
export const completionRetry = plan => plan.retry.filter(task => !plan.excluded.some(excluded => excluded.taskId === task.taskId));
export const completionExclusions = plan => plan.excluded.map(({ id, taskId, profileId, reason }) => ({ conversationId: id, taskId, profileId, reason }));
export function verifyCompletionExclusion(state, plan) {
  for (const excluded of plan.excluded) {
    const task = state.tasks.find(row => row.id === excluded.taskId), evaluation = state.evaluations.find(row => row.id === excluded.evaluationId);
    if (!task || !evaluation || digest(task) !== excluded.taskHash || digest(evaluation) !== excluded.evaluationHash) completionFailure('EXCLUDED_RECORD_CHANGED');
  }
}
export function assertCompletionStable(state, registry, plan) {
  assertCompletionPlan(plan);
  if (state.settings.evaluationMaintenance !== RECOVERY_ID || state.settings.tuesdayWednesdayCompletion?.id !== COMPLETION_ID) completionFailure('MAINTENANCE_CHANGED');
  if (digest(state.settings.aiPolicy) !== plan.policyHash || digest(state.catalog) !== plan.catalogHash) completionFailure('CONFIGURATION_CHANGED');
  const bound = registry.forState(state); plan.profiles.forEach(p => bound.resolve(p.id, p));
  if (state.jobs.some(j => j.status === 'running' && !ownJob(j))) completionFailure('OTHER_JOB_RUNNING');
  verifyPreservedResults(state, { completed: plan.protected });
  verifyCompletionExclusion(state, plan);
}
export function assertCompletionSource(state, plan, ids, requireNew = false) {
  const byId = new Map(completionSources(plan).map(c => [c.id, c]));
  for (const id of ids) {
    // The authorized exclusion retains its audit snapshot and saved-result
    // hashes, but later Atom changes must not block the eligible cohort.
    if (plan.excluded.some(excluded => excluded.id === id)) continue;
    const expected = byId.get(id), sources = state.conversations.filter(c => c.id === id);
    if (!expected || sources.length !== 1 || !sources[0].messages?.length) completionFailure('SOURCE_CHANGED');
    const actual = evaluationContext(sources[0], state.catalog);
    if (contextKeys.some(key => actual[key] !== expected[key]) || sources[0].country !== expected.country
      || day(sources[0].lastActivityAt) !== expected.activityDay || day(sources[0].startedAt) !== expected.startedDay
      || (sources[0].ingestionBatchId ?? null) !== expected.ingestionBatchId) completionFailure('SOURCE_CHANGED');
    if (requireNew && (state.tasks.some(t => t.conversationId === id) || state.evaluations.some(e => e.conversationId === id))) completionFailure('CONVERSATION_ALREADY_ASSIGNED');
  }
}

export function prepareCompletion(state, registry, plan, timestamp) {
  assertCompletionPlan(plan);
  if (state.settings.evaluationMaintenance !== RECOVERY_ID || state.settings.tuesdayWednesdayCompletion
    && state.settings.tuesdayWednesdayCompletion.id !== COMPLETION_ID) completionFailure('MAINTENANCE_CHANGED');
  if (state.jobs.some(j => j.status === 'running')) completionFailure('EVALUATION_RUNNING');
  verifyPreservedResults(state, { completed: plan.protected });
  verifyCompletionExclusion(state, plan);
  const bound = registry.forState(state); plan.profiles.forEach(p => bound.resolve(p.id, p));
  if (digest(state.settings.aiPolicy) !== plan.policyHash || digest(state.catalog) !== plan.catalogHash) completionFailure('CONFIGURATION_CHANGED');
  for (const group of [plan.tuesday, plan.wednesday]) {
    if (group.some(c => state.tasks.some(t => t.conversationId === c.id) || state.evaluations.some(e => e.conversationId === c.id))) completionFailure('CONVERSATION_ALREADY_ASSIGNED');
  }
  state.settings.tuesdayWednesdayCompletion = { id: COMPLETION_ID, status: 'prepared', preparedAt: timestamp,
    conversations: 212, requestedConversations: 213, additionalConversations: 210, requestedScope: { tuesday: 170, wednesday: 43 },
    excluded: completionExclusions(plan), eligibleScope: { tuesday: 169, wednesday: 43 }, concurrency: 1 };
  for (const job of state.jobs.filter(j => RECOVERY_JOBS.includes(j.id) && j.status !== 'completed')) job.concurrency = 1;
}

// A higher limit is permitted only during a stopped-worker restart, after ten
// fresh conversations have completed with both models and no unresolved errors.
export function setCompletionConcurrency(state, plan, concurrency) {
  if (![1, 2].includes(concurrency)) completionFailure('INVALID_CONCURRENCY');
  if (concurrency === 2) {
    const newIds = new Set([...plan.tuesday, ...plan.wednesday].map(c => c.id));
    const tasks = completionTasks(state, plan).filter(t => newIds.has(t.conversationId));
    const complete = [...newIds].filter(id => { const rows = tasks.filter(t => t.conversationId === id); return rows.length === 2 && rows.every(t => t.status === 'completed'); });
    if (complete.length < 10 || tasks.some(t => ['partial', 'failed', 'running'].includes(t.status) || t.status === 'interrupted' && t.error)) completionFailure('CONCURRENCY_PILOT_REQUIRED');
  }
  state.settings.tuesdayWednesdayCompletion.concurrency = concurrency;
  for (const job of state.jobs.filter(j => ownJob(j) && j.status !== 'completed')) job.concurrency = concurrency;
}

export function completionTasks(state, plan) {
  const retries = new Set(completionRetry(plan).map(t => t.taskId));
  const keys = new Set(Object.values(COMPLETION_KEYS));
  const jobIds = new Set(state.jobs.filter(j => keys.has(j.idempotencyKey)).map(j => j.id));
  return state.tasks.filter(t => retries.has(t.id) || jobIds.has(t.jobId));
}
export function assertPhaseJob(state, plan, phase) {
  const jobs = state.jobs.filter(j => j.idempotencyKey === COMPLETION_KEYS[phase]);
  if (jobs.length > 1) completionFailure('DUPLICATE_COMPLETION_JOB');
  const job = jobs[0]; if (!job) return null;
  const ids = plan[phase].map(c => c.id);
  if (job.maintenanceId !== RECOVERY_ID || job.purpose !== 'operational' || job.mode !== 'dual'
    || digest(job.conversationIds) !== digest(ids) || !same(job.modelProfiles, plan.profiles)
    || state.tasks.filter(t => t.jobId === job.id).length !== ids.length * 2) completionFailure('COMPLETION_JOB_CHANGED');
  return job;
}
export function completionStatus(state, plan, manifest = {}, workerAlive = false) {
  assertCompletionPlan(plan);
  verifyCompletionExclusion(state, plan);
  const tasks = completionTasks(state, plan), completed = tasks.filter(t => t.status === 'completed');
  const count = ids => ids.filter(id => {
    const retry = plan.retry.find(t => t.id === id);
    const selected = retry ? tasks.filter(t => t.id === retry.taskId) : tasks.filter(t => t.conversationId === id);
    return selected.length === (retry ? 1 : 2) && selected.every(t => t.status === 'completed');
  }).length;
  const tuesday = [...completionRetry(plan), ...plan.tuesday].map(c => c.id), wednesday = plan.wednesday.map(c => c.id);
  const finalized = state.settings.tuesdayWednesdayCompletion?.id === COMPLETION_ID && state.settings.tuesdayWednesdayCompletion.status === 'completed'
    && state.settings.evaluationMaintenance === plan.priorMaintenance && tasks.length === 422 && completed.length === 422;
  return { id: COMPLETION_ID, status: finalized ? 'completed' : manifest.status || 'not_started', workerAlive, checkedAt: new Date().toISOString(),
    requestedConversations: 213, totalConversations: 212, excludedConversations: 1, exclusions: completionExclusions(plan), completedConversations: count([...tuesday, ...wednesday]),
    totalModelTasks: 422, completedModelTasks: completed.length, remainingModelTasks: 422 - completed.length,
    tuesday: { requested: 170, total: 169, excluded: 1, completed: count(tuesday) }, wednesday: { total: 43, completed: count(wednesday) },
    progress: COMPLETION_MODELS.map(profileId => ({ profileId, completed: completed.filter(t => t.profile.id === profileId).length,
      running: tasks.filter(t => t.profile.id === profileId && t.status === 'running').length,
      partial: tasks.filter(t => t.profile.id === profileId && ['partial', 'failed'].includes(t.status)).length })),
    errors: tasks.filter(t => !['completed', 'pending', 'running'].includes(t.status)).reduce((out, t) => {
      const code = /^[A-Z_]{3,80}$/.test(t.error?.code || '') ? t.error.code : t.status; out[code] = (out[code] || 0) + 1; return out;
    }, {}), preservedCompletedTasks: verifyPreservedResults(state, { completed: plan.protected }),
    maintenanceActive: state.settings.evaluationMaintenance === RECOVERY_ID, concurrency: state.settings.tuesdayWednesdayCompletion?.concurrency || 1, startedAt: manifest.startedAt || null,
    updatedAt: manifest.updatedAt || null, finishedAt: finalized ? state.settings.tuesdayWednesdayCompletion.finishedAt : manifest.finishedAt || null, errorCode: finalized ? null : manifest.errorCode || null };
}
// Database completion is authoritative if a filesystem write failed after the
// final transaction. Reconciliation never reclaims maintenance or starts work.
export function finalizedCompletion(state, registry, plan) {
  if (state.settings.tuesdayWednesdayCompletion?.id !== COMPLETION_ID || state.settings.tuesdayWednesdayCompletion.status !== 'completed') return null;
  assertCompletionPlan(plan);
  const timestamp = state.settings.tuesdayWednesdayCompletion.finishedAt;
  if (state.settings.evaluationMaintenance !== plan.priorMaintenance || !Number.isFinite(Date.parse(timestamp))) completionFailure('COMPLETION_STATE_CHANGED');
  if (digest(state.settings.aiPolicy) !== plan.policyHash || digest(state.catalog) !== plan.catalogHash) completionFailure('CONFIGURATION_CHANGED');
  const bound = registry.forState(state); plan.profiles.forEach(p => bound.resolve(p.id, p));
  verifyPreservedResults(state, { completed: plan.protected });
  verifyCompletionExclusion(state, plan);
  const tasks = completionTasks(state, plan);
  if (tasks.length !== 422 || tasks.some(t => t.status !== 'completed')) completionFailure('COMPLETION_STATE_CHANGED');
  for (const phase of ['tuesday', 'wednesday']) assertPhaseJob(state, plan, phase);
  return timestamp;
}
export function finishCompletion(state, registry, plan, timestamp) {
  assertCompletionStable(state, registry, plan);
  const tasks = completionTasks(state, plan);
  if (tasks.length !== 422 || tasks.some(t => t.status !== 'completed')) completionFailure('COMPLETION_NOT_FINISHED');
  for (const phase of ['tuesday', 'wednesday']) assertPhaseJob(state, plan, phase);
  state.settings.evaluationMaintenance = plan.priorMaintenance;
  Object.assign(state.settings.tuesdayWednesdayCompletion, { status: 'completed', finishedAt: timestamp });
  if (state.settings.gemmaIncidentRecovery?.id === RECOVERY_ID) Object.assign(state.settings.gemmaIncidentRecovery, {
    status: 'partial', completedAt: null, updatedAt: timestamp, exclusions: completionExclusions(plan), exclusionReason: COMPLETION_EXCLUSION_REASON });
}

// Enforced before SQL persistence: no caller may mutate an unrelated job, a
// completed task, a saved answer or any application setting outside this run.
export function assertCompletionMutation(before, after, plan) {
  const fields = ['catalog', 'catalogVersions', 'catalogAudit', 'modelPolicies', 'users', 'sessions', 'reviews', 'verdicts', 'comparisons', 'exposures', 'validations', 'metadata'];
  for (const field of fields) if (!same(before[field], after[field])) completionFailure('UNRELATED_RECORD_CHANGED');
  const allowedSettings = new Set(['evaluationMaintenance', 'tuesdayWednesdayCompletion', 'gemmaIncidentRecovery']);
  for (const key of new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])) {
    if (!allowedSettings.has(key) && !same(before.settings[key], after.settings[key])) completionFailure('UNRELATED_SETTING_CHANGED');
  }
  if (![RECOVERY_ID, plan.priorMaintenance].includes(after.settings.evaluationMaintenance) || after.settings.tuesdayWednesdayCompletion?.id !== COMPLETION_ID) completionFailure('MAINTENANCE_CHANGED');
  const targetIds = new Set(completionSources(plan).filter(c => !plan.excluded.some(excluded => excluded.id === c.id)).map(c => c.id));
  const ownJobs = new Set(after.jobs.filter(ownJob).map(j => j.id));
  for (const key of ['jobs', 'tasks', 'attempts', 'evaluations', 'operationalRefs']) {
    const next = new Map(after[key].map(r => [r.id, r]));
    if (next.size !== after[key].length) completionFailure('DUPLICATE_RECORD');
    for (const row of before[key]) {
      const changed = next.get(row.id);
      if (!changed) completionFailure('EXISTING_RECORD_REMOVED');
      if (digest(row) === digest(changed)) continue;
      if (key === 'evaluations' || key === 'attempts' && (row.status !== 'running' || !ownJobs.has(row.jobId) || !before.tasks.some(t => t.id === row.taskId && t.jobId === row.jobId && ownJobs.has(t.jobId) && targetIds.has(t.conversationId)))
        || key === 'jobs' && !ownJob(row) || key === 'tasks' && (row.status === 'completed' || !ownJobs.has(row.jobId) || !targetIds.has(row.conversationId))
        || key === 'operationalRefs' && !targetIds.has(row.id)) completionFailure('PROTECTED_RECORD_CHANGED');
      if (key === 'jobs') {
        const mutable = new Set(['status', 'updatedAt', 'finishedAt', 'completed', 'failed', 'partial', 'errors', 'concurrency']);
        for (const field of new Set([...Object.keys(row), ...Object.keys(changed)])) if (!mutable.has(field) && !same(row[field], changed[field])) completionFailure('JOB_IDENTITY_CHANGED');
      }
      if (key === 'tasks') {
        for (const field of ['jobId', 'conversationId', 'profile', 'fallback', 'context', 'codeResults']) if (!same(row[field], changed[field])) completionFailure('TASK_IDENTITY_CHANGED');
        for (const [profile, values] of Object.entries(row.profileStates || {})) for (const result of values.results || []) {
          const retained = changed.profileStates?.[profile]?.results?.find(r => r.variableId === result.variableId);
          if (!retained || digest(result) !== digest(retained)) completionFailure('RETAINED_RESULT_CHANGED');
        }
      }
      if (key === 'attempts') for (const field of ['jobId', 'taskId', 'round', 'profileId', 'provider', 'requestedModel', 'variableIds', 'startedAt']) {
        if (!same(row[field], changed[field])) completionFailure('ATTEMPT_IDENTITY_CHANGED');
      }
    }
    for (const row of after[key].filter(r => !before[key].some(old => old.id === r.id))) {
      if (key === 'jobs' && !Object.values(COMPLETION_KEYS).includes(row.idempotencyKey)
        || key === 'tasks' && (!ownJobs.has(row.jobId) || !targetIds.has(row.conversationId))
        || key === 'evaluations' && (!ownJobs.has(row.jobId) || !targetIds.has(row.conversationId))
        || key === 'attempts' && !after.tasks.some(t => t.id === row.taskId && ownJobs.has(t.jobId) && targetIds.has(t.conversationId))
        || key === 'operationalRefs' && !targetIds.has(row.id)) completionFailure('OUT_OF_SCOPE_INSERT');
    }
  }
  verifyPreservedResults(after, { completed: plan.protected });
  verifyCompletionExclusion(after, plan);
}
