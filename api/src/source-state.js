import { createHash } from 'node:crypto';

// Hash the evaluable content, not ingestion timestamps. A repeated import is not a new review.
export const sourceFingerprint = c => createHash('sha256').update(JSON.stringify({
  id: c.id, country: c.country ?? null, completed: c.completed ?? true,
  messages: c.messages.map(m => ({ id: m.id, actor: m.actor, text: m.text, timestamp: m.timestamp ?? null })),
})).digest('hex');

export function currentEvaluation(state, conversation) {
  return state.evaluations?.find(e => e.id === conversation.evaluationId)
    || state.evaluations?.slice().reverse().filter(e => e.conversationId === conversation.id && e.purpose !== 'comparison')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
export function needsEvaluation(state, conversation, refreshChanged = false) {
  const evaluation = currentEvaluation(state, conversation);
  if (!evaluation) return !conversation.evaluationId;
  return !!(refreshChanged && evaluation.sourceHash && evaluation.sourceHash !== sourceFingerprint(conversation));
}
