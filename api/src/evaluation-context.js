import { createHash } from 'node:crypto';
import { systemInstructions, PROMPT_VERSION, RULES_VERSION } from './evaluator.js';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceFingerprint = c => digest({ id: c.id, country: c.country ?? null, completed: c.completed ?? true,
  messages: c.messages.map(m => ({ id: m.id, actor: m.actor, text: m.text, timestamp: m.timestamp ?? null })) });
export const catalogReferences = catalog => catalog.map(v => ({ id: v.id, version: v.version, active: v.active }));
export function evaluationContext(conversation, catalog) {
  return { sourceHash: sourceFingerprint(conversation), catalogHash: digest(catalogReferences(catalog)),
    promptVersion: PROMPT_VERSION, promptHash: digest(systemInstructions), rulesVersion: RULES_VERSION };
}
export const historicalProfileId = evaluation => (evaluation.profileId && evaluation.modelConfiguration?.configurationHash ? `${evaluation.profileId}@${evaluation.modelConfiguration.configurationHash}` : evaluation.profileId) || `legacy:${evaluation.model || (evaluation.demo ? 'demo' : 'unknown')}`;
export function ensureEvaluationState(state) {
  for (const key of ['operationalRefs', 'comparisons', 'tasks', 'attempts', 'verdicts', 'exposures', 'validations', 'modelPolicies']) state[key] ||= [];
  const assigned = new Set(state.operationalRefs.map(r => r.id));
  const legacy = new Map();
  for (const e of state.evaluations) if (e.purpose !== 'comparison' && !assigned.has(e.conversationId)) {
    if (!legacy.has(e.conversationId) || e.createdAt > legacy.get(e.conversationId).createdAt) legacy.set(e.conversationId, e);
  }
  for (const [id, e] of legacy) state.operationalRefs.push({ id, evaluationId: e.id });
  return state;
}
export function selectedEvaluation(state, conversation, profileId) {
  if (profileId) return state.evaluations.filter(e => e.conversationId === conversation.id && historicalProfileId(e) === profileId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const ref = state.operationalRefs?.find(r => r.id === conversation.id);
  return state.evaluations.find(e => e.id === (ref?.evaluationId || conversation.evaluationId));
}
export function latestVerdict(state, conversationId, sourceHash, variableId, version) {
  if (!sourceHash) return null;
  return (state.verdicts || []).filter(v => v.conversationId === conversationId && v.sourceHash === sourceHash && v.variableId === variableId && v.catalogVersion === version).at(-1) || null;
}
export function exposeEvaluation(state, userId, evaluation) {
  if (!evaluation?.sourceHash) return;
  ensureEvaluationState(state);
  const id = digest([userId, evaluation.conversationId, evaluation.sourceHash, evaluation.catalogHash]);
  if (!state.exposures.some(e => e.id === id)) state.exposures.push({ id, userId, conversationId: evaluation.conversationId,
    sourceHash: evaluation.sourceHash, catalogVersions: evaluation.catalogVersions, createdAt: new Date().toISOString() });
}
export const wasExposed = (state, userId, conversationId, sourceHash, variableId, version) => (state.exposures || []).some(e =>
  e.userId === userId && e.conversationId === conversationId && e.sourceHash === sourceHash && e.catalogVersions.some(v => v.id === variableId && v.version === version && v.active));
