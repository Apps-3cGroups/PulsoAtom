import { RECOVERY_JOBS } from './gemma-incident-recovery.js';
import { GatewayApiClient } from './services/gatewayApiClient.js';

export function recoveryCapacity(inventory, model) {
  const models = (Array.isArray(inventory?.models) ? inventory.models : []).filter(m => m?.key === model && m.type === 'llm');
  if (models.length !== 1 || !Array.isArray(models[0].loaded_instances) || models[0].loaded_instances.length !== 1) return 1;
  const capacity = models[0].loaded_instances[0].config?.parallel;
  return Number.isInteger(capacity) && capacity > 0 ? Math.min(capacity, 4) : 1;
}
export async function readRecoveryCapacity(profile, token) {
  try {
    const client = new GatewayApiClient({ baseUrl: profile.evaluator.baseUrl, token,
      portalKey: profile.evaluator.portalKey, timeoutMs: 30000 });
    const inventory = await client.invoke({ toolKey: profile.evaluator.toolKey, method: 'GET', path: '/api/v1/models', operation: 'preflight' });
    return recoveryCapacity(inventory.response, profile.model);
  } catch { return 1; }
}
function completeConversations(tasks, completedIds) {
  const groups = new Map();
  for (const task of tasks) {
    if (!groups.has(task.conversationId)) groups.set(task.conversationId, []);
    groups.get(task.conversationId).push(task);
  }
  return [...groups.values()].filter(group => ['clef-local', 'gemma-local'].every(id => group.some(t => t.profile.id === id))
    && group.every(t => completedIds ? completedIds.has(t.id) : t.status === 'completed')).length;
}
export function recoveryBaseline(state, plan, startedAt, finishedAt) {
  const tasks = state.tasks.filter(t => RECOVERY_JOBS.includes(t.jobId) && t.status !== 'deferred');
  const completed = completeConversations(tasks) - completeConversations(tasks, new Set(plan.completed.map(t => t.taskId)));
  const elapsedMs = Date.parse(finishedAt) - Date.parse(startedAt);
  if (completed < 4 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  return { completed, elapsedMs, perMinute: completed * 60000 / elapsedMs, measuredAt: finishedAt };
}
export function recoveryPilotResult(state, { jobId, conversationIds, startedAt, finishedAt, baselineRate }) {
  const tasks = state.tasks.filter(t => t.jobId === jobId && conversationIds.includes(t.conversationId));
  const taskIds = new Set(tasks.map(t => t.id));
  const completed = completeConversations(tasks);
  const runtimeCodes = new Set(['AI_TRANSIENT', 'AI_UNAVAILABLE', 'AI_CONFIGURATION', 'MODEL_CHANGED', 'MODEL_IDENTITY_UNVERIFIED', 'AI_INCOMPLETE']);
  const runtimeErrors = state.attempts.filter(a => taskIds.has(a.taskId) && a.startedAt >= startedAt && runtimeCodes.has(a.error?.code)).length;
  const elapsedMs = Date.parse(finishedAt) - Date.parse(startedAt);
  const perMinute = elapsedMs > 0 ? completed * 60000 / elapsedMs : 0;
  const improved = completed === conversationIds.length && !runtimeErrors && baselineRate > 0 && perMinute > baselineRate * 1.05;
  return { requested: conversationIds.length, completed, runtimeErrors, elapsedMs, perMinute, baselineRate,
    concurrency: improved ? 4 : 2, startedAt, finishedAt };
}
