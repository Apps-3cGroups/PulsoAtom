import { catalogReferences, digest, evaluationContext } from './evaluation-context.js';
import { evaluationMatchesProfile } from './operational-evaluation.js';

// Reuse only the currently published operational pair. Two unrelated historic
// answers do not establish a usable current result, even when their text agrees.
export function completedOperationalPair(state, conversation, profiles) {
  if (!Array.isArray(profiles) || profiles.length !== 2 || new Set(profiles.map(p => `${p.provider}:${p.model}`)).size !== 2) return false;
  const reference = state.operationalRefs?.find(ref => ref.id === conversation.id);
  const anchor = state.evaluations.find(e => e.id === reference?.evaluationId);
  const job = state.jobs.find(j => j.id === anchor?.jobId);
  if (!anchor || job?.purpose !== 'operational' || job.mode !== 'dual' || job.modelProfiles?.length !== 2) return false;
  const context = evaluationContext(conversation, state.catalog);
  const contextMatches = value => value && Object.entries(context).every(([key, expected]) => value[key] === expected);
  const expectedRefs = digest(catalogReferences(state.catalog));
  const active = state.catalog.filter(v => !v.retired && v.active).map(v => v.id);
  const tasks = state.tasks.filter(t => t.jobId === job.id && t.conversationId === conversation.id);
  if (!active.length || tasks.length !== 2 || !contextMatches(anchor)) return false;
  return profiles.every(profile => {
    const task = tasks.find(t => t.profile?.id === profile.id);
    const savedProfile = job.modelProfiles.find(p => p.id === profile.id);
    const sameProfile = value => value && ['id', 'provider', 'model', 'configurationHash'].every(key => profile[key] && value[key] === profile[key]);
    if (!sameProfile(savedProfile) || !sameProfile(task?.profile) || task.status !== 'completed' || task.error || !contextMatches(task.context)) return false;
    const evaluation = state.evaluations.find(e => e.id === task.evaluationId && e.taskId === task.id && e.jobId === job.id && e.conversationId === conversation.id);
    if (!evaluation || evaluation.purpose !== 'operational' || evaluation.partial || evaluation.error || evaluation.validationErrors?.length
      || evaluation.usedFallback || evaluation.profileId !== profile.id || evaluation.requestedProfileId !== profile.id
      || evaluation.provider !== profile.provider || evaluation.model !== profile.model
      || !evaluationMatchesProfile(evaluation, profile) || !contextMatches(evaluation)
      || !Array.isArray(evaluation.catalogVersions) || digest(catalogReferences(evaluation.catalogVersions)) !== expectedRefs) return false;
    const results = evaluation.results;
    return Array.isArray(results) && results.length === active.length && new Set(results.map(r => r.variableId)).size === active.length
      && results.every(r => active.includes(r.variableId) && !r.error && ['evaluado', 'no_evaluado'].includes(r.status));
  });
}

export function dailyHandoffFor(settings, options) {
  const handoff = settings?.thursdayHandoff;
  return handoff?.id === options?.dailyActivity?.handoffId && handoff?.runDate === options.scheduleDate
    && handoff?.scopeHash === options.dailyActivity.handoffScopeHash ? handoff : null;
}

// An assigned input version is attempted only once automatically, even if its
// result is partial. A later LISTO document with changed content is a new input.
export function assignedHandoffVersion(state, conversation, options, jobs) {
  const h = dailyHandoffFor(state.settings, options);
  if (!h) return false;
  const context = evaluationContext(conversation, state.catalog);
  return jobs.some(job => job.conversationIds.includes(conversation.id) && h.profiles.every(profile =>
    state.tasks.some(task => task.jobId === job.id && task.conversationId === conversation.id
      && ['id', 'provider', 'model', 'configurationHash'].every(key => task.profile?.[key] === profile[key])
      && Object.entries(context).every(([key, value]) => task.context?.[key] === value))));
}
