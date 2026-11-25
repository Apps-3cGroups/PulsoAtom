import { sourceFingerprint } from './evaluation-context.js';

export function evaluationMatchesPrompt(evaluation, task, job) {
  if (!job?.promptSnapshot) return true;
  const expected = job.promptSnapshot.profiles[task?.profile.id]?.hash;
  return !!expected && evaluation?.modelPromptHash === expected && task.context.modelPromptHash === expected
    && evaluation.promptHash === job.promptSnapshot.hash;
}

// Derive one operational result without modifying either provider's stored answer.
const equivalent = (a, b) => a.conversationId === b.conversationId && ['sourceHash', 'catalogHash', 'promptHash', 'rulesVersion'].every(key => a[key] && a[key] === b[key]);
const conclusive = r => r?.status === 'evaluado' && [0, 1].includes(r.value);
// Shared business hashes describe source/checklist semantics, not the native
// adapter's actual instructions. Each result must also match its own frozen
// profile contract; native decisions cannot enter a historical chat cohort.
export function evaluationMatchesProfile(evaluation, profile) {
  if (!evaluation || !profile) return false;
  const configuration = evaluation.modelConfiguration;
  const native = profile.protocol === 'systemone' || evaluation.protocol === 'systemone'
    || configuration?.protocol === 'systemone' || evaluation.adapterVersion || evaluation.instructionsHash;
  if (!native) return !profile.configurationHash || configuration?.configurationHash === profile.configurationHash;
  return profile.protocol === 'systemone' && evaluation.protocol === 'systemone' && configuration?.protocol === 'systemone'
    && typeof profile.configurationHash === 'string' && /^[a-f0-9]{64}$/.test(profile.configurationHash)
    && configuration.configurationHash === profile.configurationHash
    && typeof profile.adapterVersion === 'string' && !!profile.adapterVersion
    && evaluation.adapterVersion === profile.adapterVersion && configuration.adapterVersion === profile.adapterVersion
    && /^[a-f0-9]{64}$/.test(profile.instructionsHash || '')
    && evaluation.instructionsHash === profile.instructionsHash && configuration.instructionsHash === profile.instructionsHash
    && evaluation.profileId === profile.id && evaluation.provider === profile.provider && evaluation.model === profile.model;
}
// Runtime-only provenance: stored summaries or labels cannot establish consensus.
const consensusByEvaluation = new WeakMap();
export const operationalConsensus = (evaluation, variableId) => evaluation && consensusByEvaluation.get(evaluation)?.get(variableId);
const completeLocalPairs = new WeakSet();
export const hasCompleteLocalModelPair = evaluation => !!evaluation && completeLocalPairs.has(evaluation);
const verifiedHistoricalPairs = new WeakSet();
export const hasVerifiedHistoricalModelPair = evaluation => !!evaluation && verifiedHistoricalPairs.has(evaluation);

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const cohortContextMatches = (a, b) => a && b && ['sourceHash', 'catalogHash', 'promptHash', 'promptVersion', 'rulesVersion'].every(key => a[key] && a[key] === b[key]);
const catalogRefs = values => Array.isArray(values) && values.length
  && values.every(v => v && typeof v.id === 'string' && Number.isInteger(v.version) && v.version > 0 && typeof v.active === 'boolean')
  && new Set(values.map(v => v.id)).size === values.length
  ? values.map(({ id, version, active }) => ({ id, version, active })) : null;
const sameCatalog = (a, b) => catalogRefs(a) && catalogRefs(b) && JSON.stringify(catalogRefs(a)) === JSON.stringify(catalogRefs(b));
const sameProfile = (a, b) => a && b && ['id', 'provider', 'model', 'configurationHash'].every(key => a[key] && a[key] === b[key])
  && (a.protocol || 'chat') === (b.protocol || 'chat');
const exactEvaluationProfile = (evaluation, profile) => evaluationMatchesProfile(evaluation, profile)
  && evaluation.profileId === profile.id && evaluation.provider === profile.provider && evaluation.model === profile.model
  && evaluation.requestedProfileId === profile.id && !evaluation.usedFallback;
const unique = values => values.length === 1 ? values[0] : null;
const uniqueResults = evaluation => Array.isArray(evaluation.results)
  && evaluation.results.every(r => r && typeof r.variableId === 'string')
  && new Set(evaluation.results.map(r => r.variableId)).size === evaluation.results.length;
const rowsById = (state, collection, id, index) => index ? index[collection].get(id) || []
  : (state[collection] || []).filter(row => row.id === id);
const tasksFor = (state, jobId, conversationId, index) => index ? index.tasksByJobConversation.get(jobId)?.get(conversationId) || []
  : state.tasks.filter(task => task.jobId === jobId && task.conversationId === conversationId);
const catalogVersion = (state, id, version, index) => index ? index.catalogVersions.get(id)?.get(version)?.[0]
  : state.catalogVersions?.find(item => item.itemId === id && item.version === version);

// Completion belongs to the validated current pair, including explicit cohort
// complements. A saved label, a positive vote or a valid abstention alone cannot
// establish that both executions finished without a technical incident.
function completeLocalPair(participants, anchor) {
  return participants.length === 2
    && ['clef-local', 'gemma-local'].every(id => participants.filter(p => p.profile.id === id).length === 1)
    && new Set(participants.map(p => `${p.profile.provider}:${p.profile.model}`)).size === 2
    && participants.every(({ profile, task, evaluation }) => task?.status === 'completed' && !task.error
      && evaluation && !evaluation.partial && !evaluation.error && !evaluation.validationErrors?.length
      && !evaluation.demo && !evaluation.usedFallback && profile.provider === 'gateway'
      && evaluation.provider === profile.provider && evaluation.model === profile.model
      && uniqueResults(evaluation)
      && (anchor.catalogVersions || []).filter(ref => ref.active).every(ref => {
        const ownRef = evaluation.catalogVersions?.find(item => item.id === ref.id);
        const result = evaluation.results.find(item => item.variableId === ref.id);
        return ownRef?.active && ownRef.version === ref.version && result && !result.error
          && ['evaluado', 'no_evaluado'].includes(result.status);
      }));
}

// This is an explicit additive link, not "latest result from any comparison".
// Only the frozen complement of the selected operational Gemma job can supply
// the second opinion. Stored answers and the anchor ID remain untouched.
function cohortPair(state, anchor, originalJob, index) {
  if (originalJob?.purpose !== 'operational' || originalJob.mode !== 'single' || !originalJob.maintenanceId
    || anchor.purpose !== 'operational' || anchor.profileId !== 'gemma-local' || !uniqueResults(anchor)
    || originalJob.modelProfiles?.length !== 1 || !originalJob.conversationIds?.includes(anchor.conversationId)
    || rowsById(state, 'jobs', originalJob.id, index).length !== 1
    || rowsById(state, 'evaluations', anchor.id, index).length !== 1) return null;
  const originalTask = unique(rowsById(state, 'tasks', anchor.taskId, index));
  const originalProfile = originalJob.modelProfiles[0];
  if (!originalTask || originalTask.jobId !== originalJob.id || originalTask.conversationId !== anchor.conversationId
    || originalTask.evaluationId !== anchor.id || !['completed', 'partial'].includes(originalTask.status)
    || !sameProfile(originalTask.profile, originalProfile) || !exactEvaluationProfile(anchor, originalProfile)
    || !cohortContextMatches(originalTask.context, anchor) || !sameCatalog(originalJob.catalogVersions, anchor.catalogVersions)) return null;
  const source = unique(rowsById(state, 'conversations', anchor.conversationId, index));
  const sourceChanged = !source || sourceFingerprint(source) !== anchor.sourceHash;
  const cohortId = `clef-complement-${originalJob.maintenanceId}`;
  const job = unique((index ? index.cohorts.get(cohortId) || [] : state.jobs)
    .filter(j => j.cohortId === cohortId && j.conversationIds?.includes(anchor.conversationId)));
  if (!job || job.purpose !== 'comparison' || job.mode !== 'single' || job.maintenanceId !== originalJob.maintenanceId
    || !hash(job.cohortManifestHash) || job.modelProfiles?.length !== 2
    || !job.modelProfiles.every(p => p && ['gemma-local', 'clef-local'].includes(p.id) && hash(p.configurationHash)
      && typeof p.provider === 'string' && !!p.provider.trim() && typeof p.model === 'string' && !!p.model.trim()
      && (!p.protocol || p.protocol === 'chat'))
    || new Set(job.modelProfiles.map(p => p.id)).size !== 2 || new Set(job.modelProfiles.map(p => `${p.provider}:${p.model}`)).size !== 2
    || !sameCatalog(job.catalogVersions, anchor.catalogVersions)) return null;
  const sample = unique(index ? index.comparisons.get(job.id) || [] : (state.comparisons || []).filter(s => s.jobId === job.id));
  const sampleCase = sample && unique((sample.cases || []).filter(c => c.conversationId === anchor.conversationId));
  if (!sample || sample.id !== job.id || sample.cohortId !== cohortId || sample.modelProfiles?.length !== 2
    || !job.modelProfiles.every(p => sameProfile(p, unique(sample.modelProfiles.filter(s => s?.id === p.id))))
    || !sameCatalog(sample.catalogVersions, anchor.catalogVersions) || !cohortContextMatches(sampleCase, anchor)) return null;
  const tasks = tasksFor(state, job.id, anchor.conversationId, index);
  if (tasks.some(t => !job.modelProfiles.some(p => p.id === t.profile?.id))) return null;
  const gemmaProfile = job.modelProfiles.find(p => p.id === 'gemma-local');
  const gemmaTask = unique(tasks.filter(t => t.profile?.id === 'gemma-local'));
  if (!gemmaTask || !sameProfile(gemmaProfile, originalProfile) || !sameProfile(gemmaTask.profile, gemmaProfile)
    || gemmaTask.evaluationId !== anchor.id || gemmaTask.reusedEvaluationId !== anchor.id
    || gemmaTask.reusedJobId !== originalJob.id || gemmaTask.reusedTaskId !== originalTask.id
    || gemmaTask.status !== originalTask.status || !cohortContextMatches(gemmaTask.context, anchor)) return null;
  const clefProfile = job.modelProfiles.find(p => p.id === 'clef-local');
  const clefTasks = tasks.filter(t => t.profile?.id === 'clef-local');
  if (clefTasks.length > 1) return null;
  const clefTask = clefTasks[0];
  if (clefTask && (!sameProfile(clefTask.profile, clefProfile) || !cohortContextMatches(clefTask.context, anchor)
    || clefTask.reusedEvaluationId || clefTask.reusedJobId || clefTask.reusedTaskId || clefTask.fallback
    || !['pending', 'running', 'completed', 'partial', 'failed'].includes(clefTask.status))) return null;
  let clefEvaluation = null;
  if (clefTask?.evaluationId) {
    clefEvaluation = unique(rowsById(state, 'evaluations', clefTask.evaluationId, index));
    if (!clefEvaluation || clefEvaluation.purpose !== 'comparison' || clefEvaluation.jobId !== job.id
      || clefEvaluation.taskId !== clefTask.id || clefEvaluation.conversationId !== anchor.conversationId
      || !uniqueResults(clefEvaluation) || !exactEvaluationProfile(clefEvaluation, clefProfile) || !cohortContextMatches(clefEvaluation, anchor)
      || !sameCatalog(clefEvaluation.catalogVersions, anchor.catalogVersions)) return null;
  }
  return { sourceChanged, participants: [{ profile: gemmaProfile, task: gemmaTask, evaluation: anchor, provenance: 'operational' },
    { profile: clefProfile, task: clefTask, evaluation: clefEvaluation, provenance: 'cohort-complement' }] };
}

const publicError = error => error ? { code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'EVALUATION_FAILED',
  message: 'No se obtuvo una respuesta válida del modelo para esta revisión.' } : null;
const publicResult = result => result?.error ? { ...result, error: publicError(result.error) } : result;

function modelReview(state, anchor, { profile, task, evaluation, provenance = 'operational' }, index) {
  const refs = (anchor.catalogVersions || []).filter(ref => ref.active && ['IA', 'IA + código'].includes(
    catalogVersion(state, ref.id, ref.version, index)?.snapshot?.method));
  const results = refs.flatMap(ref => evaluation?.results?.filter(r => r.variableId === ref.id) || []);
  const evaluatedCount = results.filter(r => r.status === 'evaluado' && !r.error).length;
  const abstainedCount = results.filter(r => r.status === 'no_evaluado' && !r.error).length;
  const errorCount = results.filter(r => r.error).length;
  const status = ['pending', 'running', 'failed'].includes(task?.status) ? task.status
    : !evaluation ? 'pending' : task?.status === 'partial' || evaluation.partial || errorCount || results.length < refs.length ? 'partial' : 'completed';
  return { profileId: profile.id, label: profile.label || evaluation?.profileLabel || profile.model || 'Modelo',
    model: evaluation?.model || profile.model, provider: evaluation?.provider || profile.provider, status,
    evaluatedCount, totalVariables: refs.length, abstainedCount, errorCount,
    detectedCount: results.filter(r => r.status === 'evaluado' && r.value === 1 && !r.error && !r.codeRule
      && r.type !== 'Descriptor' && !['Código', 'Cálculo'].includes(r.method)).length,
    createdAt: evaluation?.createdAt || null, purpose: evaluation?.purpose || (provenance === 'cohort-complement' ? 'comparison' : 'operational'), provenance };
}

export function operationalEvaluation(state, anchor, index) {
  if (!anchor) return anchor;
  if (index?.state !== state) index = undefined;
  const job = index ? index.jobs.get(anchor.jobId)?.[0] : state.jobs.find(j => j.id === anchor.jobId);
  const dual = job?.mode === 'dual' && job.purpose === 'operational' && job.modelProfiles?.length === 2 && new Set(job.modelProfiles.map(p => p.id)).size === 2;
  const tasks = tasksFor(state, job?.id, anchor.conversationId, index);
  const cohort = dual ? null : cohortPair(state, anchor, job, index);
  const source = dual && (index ? index.conversations.get(anchor.conversationId)?.[0] : state.conversations?.find(c => c.id === anchor.conversationId));
  const sourceChanged = !!cohort?.sourceChanged || !!(source && anchor.sourceHash && sourceFingerprint(source) !== anchor.sourceHash);
  const evaluations = dual ? job.modelProfiles.map(profile => {
    const task = tasks.find(t => t.profile.id === profile.id);
    const evaluation = (index ? index.evaluations.get(task?.evaluationId) || [] : state.evaluations).find(e => e.id === task?.evaluationId && e.jobId === job.id
      && e.taskId === task?.id && e.profileId === profile.id
      && evaluationMatchesPrompt(e, task, job)
      && equivalent(e, anchor) && evaluationMatchesProfile(e, profile));
    return { profile, task, evaluation };
  }) : cohort?.participants;
  if (!evaluations) {
    const task = index ? index.tasks.get(anchor.taskId)?.[0] : state.tasks.find(t => t.id === anchor.taskId);
    const profile = job?.modelProfiles?.find(p => p.id === anchor.profileId) || anchor.modelConfiguration
      || { id: anchor.profileId || 'historical', label: anchor.profileLabel, model: anchor.model, provider: anchor.provider };
    const modelReviews = [modelReview(state, anchor, { profile, task, evaluation: anchor }, index)];
    return { ...anchor, modelReviews, modelReviewPending: modelReviews.some(review => ['pending', 'running'].includes(review.status)) };
  }
  const completePair = completeLocalPair(evaluations, anchor);
  const verifiedHistoricalPair = completePair && evaluations.every(({ profile, task, evaluation }) =>
    exactEvaluationProfile(evaluation, profile) && sameProfile(task.profile, profile)
    && unique(rowsById(state, 'evaluations', evaluation.id, index)) === evaluation
    && unique(tasksFor(state, task.jobId, anchor.conversationId, index).filter(candidate => candidate.jobId === task.jobId
      && candidate.conversationId === anchor.conversationId && candidate.profile?.id === profile.id)) === task);
  const ids = [...new Set(evaluations.flatMap(({ evaluation }) => (evaluation?.results || []).map(r => r.variableId)))];
  const consensus = new Map();
  const results = ids.map(variableId => {
    const available = evaluations.flatMap(({ evaluation }) => evaluation?.results.filter(r => r.variableId === variableId) || []).map(publicResult);
    const first = available[0];
    const ref = anchor.catalogVersions?.find(v => v.id === variableId);
    const definition = catalogVersion(state, variableId, ref?.version, index)?.snapshot;
    const type = first.type || definition?.type;
    // Numeric metrics and categorical/list descriptors never enter binary voting.
    if (['Métrica', 'Descriptor'].includes(type)) return available.find(r => r.status === 'evaluado' && !r.error) || first;
    if (['Código', 'Cálculo'].includes(first.method || definition?.method)) return { ...first, comparison: { codeOnly: true, label: 'Calculado por Pulso · sin votos de IA', cells: [] } };
    const cells = evaluations.map(({ profile, task, evaluation }) => {
      // Matching global hashes do not replace the item's enabled/version check.
      const itemRef = evaluation?.catalogVersions?.find(v => v.id === variableId);
      if (!ref?.active || !itemRef?.active || itemRef.version !== ref.version) evaluation = null;
      return {
        profileId: profile.id, label: profile.label, provider: evaluation?.provider || profile.provider,
        model: evaluation?.model || profile.model, requestedModel: profile.model,
        identityVerified: typeof evaluation?.provider === 'string' && !!evaluation.provider.trim()
          && typeof evaluation?.model === 'string' && !!evaluation.model.trim(),
        status: evaluation?.results.find(r => r.variableId === variableId)?.error ? 'failed' : evaluation?.results.some(r => r.variableId === variableId) ? 'completed' : task?.status || 'pending', error: publicError(evaluation?.results.find(r => r.variableId === variableId)?.error || (!evaluation ? task?.error || null : null)),
        result: publicResult(evaluation?.results.find(r => r.variableId === variableId)) || null,
        evaluationId: evaluation?.id || null, sourceHash: evaluation?.sourceHash || null,
        createdAt: evaluation?.createdAt || null,
      };
    });
    const contingencyLabel = cells[0].status === 'failed' && ['AI_UNAVAILABLE', 'AI_TRANSIENT', 'INVALID_AI_RESULT', 'AI_INCOMPLETE'].includes(cells[0].error?.code) && cells[1].result ? `Evaluado con ${cells[1].label} · respaldo de ${cells[0].label}` : null;
    const seen = new Set();
    const votes = cells.filter(c => {
      const identity = `${c.provider}:${c.model}`;
      if (!c.identityVerified || !conclusive(c.result) || c.error || c.result.error || c.result.codeRule || ['Código', 'Cálculo'].includes(c.result.method) || seen.has(identity)) return false;
      seen.add(identity); return true;
    });
    const detections = votes.filter(c => c.result.value === 1).length;
    const missing = 2 - votes.length;
    const imposed = cells.some(c => c.result?.codeRule);
    const agreement = imposed ? 'rule' : votes.length === 2 && detections === 2 ? 'agree-positive'
      : votes.length === 2 && detections === 0 ? 'agree-negative' : votes.length === 2 ? 'disagree' : 'incomplete';
    // Historical agreement is a read-only presentation of these same verified
    // saved answers. It never certifies the current source or enables reviews.
    consensus.set(variableId, { detected: !sourceChanged && agreement === 'agree-positive',
      historicalDetected: sourceChanged && verifiedHistoricalPair && agreement === 'agree-positive',
      pending: agreement === 'incomplete', agreement });
    const label = ({ rule: 'Resultado con regla de código · sin consenso independiente', 'agree-positive': 'Detectado por 2 modelos',
      'agree-negative': 'Ningún modelo detecta el evento', disagree: 'Discrepancia · requiere revisión',
      incomplete: `${detections} detección${detections === 1 ? '' : 'es'} · comparación incompleta` })[agreement];
    const positives = available.filter(r => conclusive(r) && r.value === 1 && !r.error);
    const allNegative = cells.every(c => conclusive(c.result) && c.result.value === 0 && !c.result.error);
    const result = positives[0] || first;
    const evidence = [...new Map(positives.flatMap(r => r.evidence || []).map(e => [`${e.messageId}:${e.quote}`, e])).values()];
    const evidenceSets = positives.map(r => new Set((r.evidence || []).map(e => e.messageId)));
    const commonEvidence = evidenceSets.length > 1 && [...evidenceSets[0]].some(id => evidenceSets.every(set => set.has(id)));
    return { ...result, status: positives.length || allNegative ? 'evaluado' : 'no_evaluado', value: positives.length ? 1 : allNegative ? 0 : null,
      evidence: positives.length ? evidence : [], comparison: { cells, contingencyLabel, detections, votes: votes.length, expected: 2, missing, agreement, label, commonEvidence,
        ...(sourceChanged ? { sourceChanged: true } : {}) } };
  });
  const modelReviews = evaluations.map(participant => modelReview(state, anchor, participant, index));
  const operational = { ...anchor, dual: true, results, modelReviews, modelReviewPending: modelReviews.some(review => ['pending', 'running'].includes(review.status)) };
  consensusByEvaluation.set(operational, consensus);
  if (completePair && modelReviews.every(review => review.status === 'completed' && !review.errorCount)) completeLocalPairs.add(operational);
  if (verifiedHistoricalPair && completeLocalPairs.has(operational)) verifiedHistoricalPairs.add(operational);
  return operational;
}
