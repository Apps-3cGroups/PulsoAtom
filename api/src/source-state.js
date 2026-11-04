import { selectedEvaluation, sourceFingerprint } from './evaluation-context.js';

// Hash the evaluable content, not ingestion timestamps. A repeated import is not a new review.
export { sourceFingerprint };

export function currentEvaluation(state, conversation) {
  return selectedEvaluation(state, conversation)
    || state.evaluations?.slice().reverse().filter(e => e.conversationId === conversation.id && e.purpose !== 'comparison' && !e.taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
export function needsEvaluation(state, conversation, refreshChanged = false) {
  const evaluation = currentEvaluation(state, conversation);
  if (!evaluation) return !conversation.evaluationId;
  return !!(refreshChanged && evaluation.sourceHash && evaluation.sourceHash !== sourceFingerprint(conversation));
}
