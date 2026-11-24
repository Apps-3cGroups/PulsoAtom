import { AppError } from './errors.js';
import { copySourceFingerprint, sourceFingerprint } from './evaluation-context.js';
import { evaluationMatchesProfile, evaluationMatchesPrompt } from './operational-evaluation.js';

const unavailable = () => new AppError(409, 'La selección guardada no está completa. No se sustituyeron conversaciones ni resultados.', 'REVIEW_SELECTION_INCOMPLETE');
const uniqueBy = (items, id) => { const found = items.filter(item => item.id === id); return found.length === 1 ? found[0] : null; };
const sameProfile = (a, b) => a && b && ['id', 'provider', 'model', 'configurationHash'].every(key => a[key] === b[key])
  && (a.protocol || 'chat') === (b.protocol || 'chat');
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

export function requireReviewSelection(state, id) {
  const selection = state.reviewSelection;
  if (!selection || selection.id !== id) throw new AppError(404, 'No se encontró esta selección para revisión.', 'REVIEW_SELECTION_NOT_FOUND');
  const cases = selection.cases;
  if (!Array.isArray(cases) || !cases.length || cases.length > 500 || selection.caseCount !== cases.length
    || new Set(cases.map(item => item.conversationId)).size !== cases.length
    || !date(selection.scope?.from) || !date(selection.scope?.to) || selection.scope.from > selection.scope.to
    || cases.some(item => typeof item.conversationId !== 'string' || !item.conversationId || !date(item.activityDate)
      || item.activityDate < selection.scope.from || item.activityDate > selection.scope.to
      || !/^[A-Z]{2}$/.test(item.country) || !Number.isFinite(Date.parse(item.activityAt)))) throw unavailable();
  return selection;
}

export function publicReviewSelection(state) {
  if (!state.reviewSelection) return null;
  const selection = requireReviewSelection(state, state.reviewSelection.id);
  const counts = new Map();
  for (const item of selection.cases) counts.set(item.country, (counts.get(item.country) || 0) + 1);
  return { id: selection.id, title: selection.title || 'Selección para revisión', from: selection.scope.from, to: selection.scope.to,
    count: selection.cases.length, countries: [...counts].map(([code, count]) => ({ code, count })),
    reviewAt: selection.reviewDeadline, sourceChangedCount: selection.sourceChangedCount || 0, timeCorrectionCount: selection.timeCorrectionCount || 0 };
}

// A read-only projection of the exact saved pair. It never changes operational
// references, worker tasks, model answers or source hashes in persistence.
export function applyReviewSelection(state, id) {
  const selection = requireReviewSelection(state, id);
  const conversations = [], evaluations = [], tasks = [], operationalRefs = [];
  let sourceChangedCount = 0;
  for (const item of selection.cases) {
    const anchorId = item.selectionAnchorEvaluationId || item.publishedAnchorEvaluationId;
    const conversation = uniqueBy(state.conversations, item.conversationId);
    const job = uniqueBy(state.jobs, item.jobId);
    if (!conversation || conversation.country !== item.country || !job || job.purpose !== 'operational' || job.mode !== 'dual'
      || job.modelProfiles?.length !== 2 || !Array.isArray(item.models) || item.models.length !== 2
      || new Set(item.models.map(model => model.profileId)).size !== 2
      || !item.models.some(model => model.evaluationId === anchorId)) throw unavailable();
    const pair = [];
    for (const model of item.models) {
      const evaluation = uniqueBy(state.evaluations, model.evaluationId);
      const originalTask = uniqueBy(state.tasks, model.taskId);
      const profile = job.modelProfiles.find(value => value.id === model.profileId);
      const task = originalTask && { ...originalTask, profile: profile && structuredClone(profile), status: 'completed', evaluationId: model.evaluationId,
        context: { ...originalTask.context, modelPromptHash: model.modelPromptHash } };
      if (!evaluation || !task || !profile || task.jobId !== job.id || task.conversationId !== item.conversationId
        || !sameProfile(originalTask.profile, profile) || evaluation.purpose !== 'operational' || evaluation.partial
        || evaluation.error || evaluation.validationErrors?.length || evaluation.demo || evaluation.usedFallback
        || evaluation.requestedProfileId !== profile.id
        || ['catalogHash', 'promptHash', 'promptVersion', 'rulesVersion'].some(key => !item.context?.[key] || evaluation[key] !== item.context[key])
        || evaluation.jobId !== job.id || evaluation.taskId !== task.id || evaluation.conversationId !== item.conversationId
        || evaluation.profileId !== profile.id || evaluation.provider !== model.provider || evaluation.model !== model.model
        || evaluation.provider !== profile.provider || evaluation.model !== profile.model
        || evaluation.sourceHash !== item.sourceHash || !evaluation.sourceHash
        || !evaluationMatchesProfile(evaluation, profile) || !evaluationMatchesPrompt(evaluation, task, job)
        || !Array.isArray(evaluation.results) || evaluation.results.some(result => result.error)
        || new Set(evaluation.results.map(result => result.variableId)).size !== evaluation.results.length
        || !Array.isArray(evaluation.catalogVersions) || !evaluation.catalogVersions.length
        || evaluation.catalogVersions.some(ref => ref.active && !evaluation.results.some(result => result.variableId === ref.id && ['evaluado', 'no_evaluado'].includes(result.status)))) throw unavailable();
      if (pair.length && (['sourceHash', 'catalogHash', 'promptHash', 'rulesVersion'].some(key => !evaluation[key] || evaluation[key] !== pair[0][key])
        || JSON.stringify(evaluation.catalogVersions) !== JSON.stringify(pair[0].catalogVersions))) throw unavailable();
      pair.push(evaluation); tasks.push(task);
    }
    if (new Set(pair.map(evaluation => `${evaluation.provider}:${evaluation.model}`)).size !== 2) throw unavailable();
    if (anchorId !== item.publishedAnchorEvaluationId) {
      // A task may have completed after a partial answer was published. The
      // manifest explicitly selects the completed answer, retaining provenance.
      const published = uniqueBy(state.evaluations, item.publishedAnchorEvaluationId);
      const anchor = pair.find(evaluation => evaluation.id === anchorId);
      if (!published || published.purpose !== 'operational' || published.jobId !== item.jobId
        || published.conversationId !== item.conversationId || published.taskId !== anchor.taskId
        || published.profileId !== anchor.profileId || published.provider !== anchor.provider || published.model !== anchor.model
        || ['sourceHash', 'catalogHash', 'promptHash', 'promptVersion', 'rulesVersion'].some(key => !published[key] || published[key] !== anchor[key])) throw unavailable();
    }
    evaluations.push(...pair);
    const projected = { ...conversation, evaluationId: anchorId,
      reviewSelectionDate: item.activityDate, reviewSelectionAt: item.activityAt };
    copySourceFingerprint(conversation, projected);
    if (sourceFingerprint(projected) !== item.sourceHash) sourceChangedCount += 1;
    conversations.push(projected);
    operationalRefs.push({ id: item.conversationId, evaluationId: anchorId });
  }
  return { ...state, conversations, evaluations, tasks, operationalRefs,
    reviewSelection: { ...selection, sourceChangedCount },
    metadata: { ...state.metadata, reviewSelection: { ...publicReviewSelection(state), sourceChangedCount } } };
}
