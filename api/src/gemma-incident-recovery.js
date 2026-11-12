import { digest } from './evaluation-context.js';

export const RECOVERY_DATE = '2026-11-10';
export const RECOVERY_ID = '5db71f86-2186-49a8-b715-722f93e8fc41';
export const RECOVERY_JOBS = ['340c1fcb-dc19-42a2-91af-e494eb52d753', 'ee30980f-df37-4592-bae9-3090f49f5e3e'];
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function recoveryPlan(state) {
  const jobs = RECOVERY_JOBS.map(id => state.jobs.find(j => j.id === id));
  if (jobs.some(j => !j || j.purpose !== 'operational' || j.mode !== 'dual'
    || j.dailyActivity?.date !== RECOVERY_DATE || j.dailyActivity?.timezone !== 'America/Tegucigalpa'
    || j.modelProfiles?.length !== 2 || !['clef-local', 'gemma-local'].every(id => j.modelProfiles.some(p => p.id === id)))) fail('RECOVERY_SCOPE_CHANGED');
  if (state.settings.evaluationMaintenance && state.settings.evaluationMaintenance !== RECOVERY_ID) fail('OTHER_MAINTENANCE');
  if (state.jobs.some(j => j.status === 'running' && !RECOVERY_JOBS.includes(j.id))) fail('OTHER_JOB_RUNNING');
  const tasks = state.tasks.filter(t => RECOVERY_JOBS.includes(t.jobId) && t.status !== 'deferred');
  if (tasks.some(t => !jobs.find(j => j.id === t.jobId).conversationIds.includes(t.conversationId))) fail('RECOVERY_SCOPE_CHANGED');
  const completed = tasks.filter(t => t.status === 'completed');
  const evaluations = completed.map(t => state.evaluations.find(e => e.id === t.evaluationId));
  if (evaluations.some(e => !e)) fail('COMPLETED_RESULT_MISSING');
  return { id: RECOVERY_ID, activityDate: RECOVERY_DATE, jobIds: [...RECOVERY_JOBS],
    conversationIds: [...new Set(tasks.map(t => t.conversationId))],
    completed: completed.map((t, i) => ({ taskId: t.id, taskHash: digest(t), evaluationId: evaluations[i].id, evaluationHash: digest(evaluations[i]) })),
    pending: tasks.filter(t => t.status !== 'completed').map(t => ({ id: t.id, jobId: t.jobId, conversationId: t.conversationId, profileId: t.profile.id, status: t.status })),
    priorMaintenance: state.settings.evaluationMaintenance || null };
}

// Call only after the owning evaluation worker has stopped. No result or profile
// is rewritten. Completed tasks are immutable; attempts retain their history.
export function prepareRecovery(state, plan, timestamp) {
  const current = recoveryPlan(state);
  if (digest(current) !== digest(plan)) fail('RECOVERY_STATE_CHANGED');
  state.settings.evaluationMaintenance = RECOVERY_ID;
  state.settings.gemmaIncidentRecovery = { id: RECOVERY_ID, date: RECOVERY_DATE, jobIds: [...RECOVERY_JOBS], status: 'prepared', preparedAt: timestamp };
  for (const job of state.jobs.filter(j => RECOVERY_JOBS.includes(j.id))) {
    job.maintenanceId = RECOVERY_ID;
    // Serialize the incident: the runtime intermittently rejects concurrent
    // real requests even though its inventory advertises parallel capacity.
    job.concurrency = 1;
    if (job.status === 'running') { job.status = 'interrupted'; job.finishedAt = timestamp; job.updatedAt = timestamp; }
  }
  for (const task of state.tasks.filter(t => RECOVERY_JOBS.includes(t.jobId) && t.status === 'running')) task.status = 'interrupted';
  for (const attempt of state.attempts.filter(a => RECOVERY_JOBS.includes(a.jobId) && a.status === 'running')) {
    attempt.status = 'interrupted'; attempt.finishedAt = timestamp; attempt.interruptionReason = 'authorized-gemma-identity-recovery';
  }
  verifyPreservedResults(state, plan);
}

export function verifyPreservedResults(state, plan) {
  for (const record of plan.completed) {
    const task = state.tasks.find(t => t.id === record.taskId), evaluation = state.evaluations.find(e => e.id === record.evaluationId);
    if (!task || !evaluation || digest(task) !== record.taskHash || digest(evaluation) !== record.evaluationHash) fail('COMPLETED_RESULT_CHANGED');
  }
  return plan.completed.length;
}
