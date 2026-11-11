import { operationalEvaluation } from './operational-evaluation.js';
import { createHash } from 'node:crypto';
import { evaluationInstructions, PROMPT_VERSION, RULES_VERSION } from './evaluator.js';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const navigationFingerprints = new WeakMap();
export const rememberSourceFingerprint = (conversation, fingerprint) => navigationFingerprints.set(conversation, fingerprint);
export function copySourceFingerprint(from, to) { if (navigationFingerprints.has(from)) navigationFingerprints.set(to, navigationFingerprints.get(from)); }
export const sourceFingerprint = c => navigationFingerprints.get(c) || digest({ id: c.id, country: c.country ?? null, completed: c.completed ?? true,
  messages: c.messages.map(m => ({ id: m.id, actor: m.actor, text: m.text, timestamp: m.timestamp ?? null,
    ...(c.messageAgentIdsAvailable ? { agentId: m.agentId ?? null } : {}) })),
  // Optional inputs enter the fingerprint only when used by the evaluator. The
  // shape for existing Atom conversations remains byte-for-byte compatible.
  ...(c.messageAgentIdsAvailable ? { messageAgentIdsAvailable: true } : {}),
  ...(c.buttonEventsAvailable ? { buttonEventsAvailable: true, offeredButtons: c.offeredButtons ?? null, selectedButtonIds: c.selectedButtonIds ?? null } : {}),
});
export const catalogReferences = catalog => catalog.filter(v => !v.retired).map(v => ({ id: v.id, version: v.version, active: v.active }));
export function evaluationContext(conversation, catalog) {
  return { sourceHash: sourceFingerprint(conversation), catalogHash: digest(catalogReferences(catalog)),
    promptVersion: PROMPT_VERSION, promptHash: digest(evaluationInstructions), rulesVersion: RULES_VERSION };
}
export const historicalProfileId = evaluation => (evaluation.profileId && evaluation.modelConfiguration?.configurationHash ? `${evaluation.profileId}@${evaluation.modelConfiguration.configurationHash}` : evaluation.profileId) || `legacy:${evaluation.model || (evaluation.demo ? 'demo' : 'unknown')}`;
export function ensureEvaluationState(state) {
  for (const key of ['operationalRefs', 'comparisons', 'tasks', 'attempts', 'verdicts', 'exposures', 'validations', 'modelPolicies']) state[key] ||= [];
  const assigned = new Set(state.operationalRefs.map(r => r.id));
  const legacy = new Map();
  for (const e of state.evaluations) if (e.purpose !== 'comparison' && !e.taskId && !assigned.has(e.conversationId)) {
    if (!legacy.has(e.conversationId) || e.createdAt >= legacy.get(e.conversationId).createdAt) legacy.set(e.conversationId, e);
  }
  for (const [id, e] of legacy) state.operationalRefs.push({ id, evaluationId: e.id });
  return state;
}
const group = (values, key) => values.reduce((map, value) => {
  const id = value[key]; if (!map.has(id)) map.set(id, []); map.get(id).push(value); return map;
}, new Map());
// Explicit per-read context; never reused across mutations of evaluator state.
export function evaluationSelectionContext(state) {
  return { evaluations: group(state.evaluations, 'conversationId'), byId: group(state.evaluations, 'id'), refs: group(state.operationalRefs || [], 'id') };
}
export function selectedEvaluation(state, conversation, profileId, context) {
  if (profileId) return (context?.evaluations.get(conversation.id) || state.evaluations).filter(e => e.conversationId === conversation.id && historicalProfileId(e) === profileId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const ref = context ? context.refs.get(conversation.id)?.[0] : state.operationalRefs?.find(r => r.id === conversation.id);
  const id = ref?.evaluationId || conversation.evaluationId;
  return operationalEvaluation(state, context ? context.byId.get(id)?.[0] : state.evaluations.find(e => e.id === id));
}
export function latestVerdict(state, conversationId, sourceHash, variableId, version) {
  if (!sourceHash) return null;
  return (state.verdicts || []).filter(v => v.conversationId === conversationId && v.sourceHash === sourceHash && v.variableId === variableId && v.catalogVersion === version).at(-1) || null;
}
export const evaluationExposureId = (userId, evaluation) => evaluation?.sourceHash
  ? digest([userId, evaluation.conversationId, evaluation.sourceHash, evaluation.catalogHash]) : null;
export function exposeEvaluation(state, userId, evaluation) {
  const id = evaluationExposureId(userId, evaluation);
  if (!id) return;
  ensureEvaluationState(state);
  if (!state.exposures.some(e => e.id === id)) state.exposures.push({ id, userId, conversationId: evaluation.conversationId,
    sourceHash: evaluation.sourceHash, catalogVersions: evaluation.catalogVersions, createdAt: new Date().toISOString() });
}
export const wasExposed = (state, userId, conversationId, sourceHash, variableId, version) => (state.exposures || []).some(e =>
  e.userId === userId && e.conversationId === conversationId && e.sourceHash === sourceHash && e.catalogVersions.some(v => v.id === variableId && v.version === version && v.active));
