import { digest, evaluationContext } from '../../src/evaluation-context.js';

/** Add explicit synthetic provenance for tests that exercise a published flag. */
export function dualizeEvaluation(state, conversation, evaluation = state.evaluations.find(e => e.id === conversation.evaluationId)) {
  const jobId = `synthetic-dual-${evaluation.id}`;
  const profiles = [{ id: 'synthetic-first', provider: 'openai', model: 'synthetic-first', label: 'Modelo 1 sintético' },
    { id: 'synthetic-second', provider: 'gemini', model: 'synthetic-second', label: 'Modelo 2 sintético' }];
  Object.assign(evaluation, evaluationContext(conversation, state.catalog), { catalogHash: digest(evaluation.catalogVersions), jobId, taskId: `${jobId}-0`, purpose: 'operational',
    profileId: profiles[0].id, provider: profiles[0].provider, model: profiles[0].model });
  const second = { ...structuredClone(evaluation), id: `${evaluation.id}-second`, taskId: `${jobId}-1`, profileId: profiles[1].id, provider: profiles[1].provider, model: profiles[1].model };
  state.evaluations.push(second);
  state.jobs.push({ id: jobId, purpose: 'operational', mode: 'dual', status: 'completed', modelProfiles: profiles });
  state.tasks.push(...profiles.map((profile, i) => ({ id: `${jobId}-${i}`, jobId, conversationId: conversation.id, profile,
    evaluationId: i ? second.id : evaluation.id, status: 'completed' })));
  return { first: evaluation, second, profiles, jobId };
}
