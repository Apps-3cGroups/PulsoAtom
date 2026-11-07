import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { catalogReferences, digest, evaluationContext } from './evaluation-context.js';
import { evaluationMatchesProfile } from './operational-evaluation.js';

const fail = (code, message) => { throw new AppError(409, message, code); };
const contextKeys = ['sourceHash', 'catalogHash', 'promptVersion', 'promptHash', 'rulesVersion'];
const contextOf = value => Object.fromEntries(contextKeys.map(key => [key, value[key]]));
const sameContext = (a, b) => contextKeys.every(key => a?.[key] && a[key] === b?.[key]);
const sameCatalog = (a, b) => Array.isArray(a) && Array.isArray(b)
  && digest(catalogReferences(a)) === digest(catalogReferences(b));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const frozenManifest = manifest => ({ format: manifest.format, id: manifest.id, createdAt: manifest.createdAt,
  profile: manifest.profile, policyVersion: manifest.policyVersion, catalogVersions: manifest.catalogVersions,
  ...(manifest.selection && typeof manifest.selection === 'object' ? { selection: manifest.selection } : {}),
  ...(manifest.revision ? { revision: manifest.revision } : {}), conversations: manifest.conversations });

// A preparation helper only: no state mutation, source transcript copies,
// inference, or replacement of the existing operational Gemma references.
export function createClefCohortBatch(state, manifest, clefProfile, conversationIds, index) {
  if (state.metadata?.demo !== false || manifest?.format !== 2 || !uuid(manifest.id)
    || manifest.conversations?.length !== 500 || new Set(manifest.conversations.map(c => c.id)).size !== 500
    || !hash(manifest.integrityHash) || digest(frozenManifest(manifest)) !== manifest.integrityHash) {
    fail('INVALID_CLEF_COHORT', 'La revisión requiere el manifiesto íntegro de las mismas 500 conversaciones.');
  }
  if (state.settings?.evaluationMaintenance !== manifest.id || state.settings.dailyEnabled !== false) {
    fail('EVALUATION_MAINTENANCE', 'Conserva el mantenimiento exacto y la programación pausada durante la revisión.');
  }
  const gemmaProfile = manifest.profile;
  if (gemmaProfile?.id !== 'gemma-local' || gemmaProfile.provider !== 'gateway' || gemmaProfile.demo
    || !hash(gemmaProfile.configurationHash) || !gemmaProfile.model || (gemmaProfile.protocol && gemmaProfile.protocol !== 'chat')
    || clefProfile?.id !== 'clef-local' || clefProfile.provider !== 'gateway' || clefProfile.model !== 'clef-flash'
    || clefProfile.demo || !hash(clefProfile.configurationHash) || (clefProfile.protocol && clefProfile.protocol !== 'chat')
    || gemmaProfile.model === clefProfile.model) fail('MODEL_CHANGED', 'Los perfiles deben identificar a Gemma original y Clef Flash con sus configuraciones fijas.');
  if (!Number.isInteger(index) || index < 0 || !Array.isArray(conversationIds) || conversationIds.length < 1 || conversationIds.length > 20
    || new Set(conversationIds).size !== conversationIds.length || conversationIds.some(id => typeof id !== 'string' || !manifest.conversations.some(c => c.id === id))) {
    fail('INVALID_CLEF_COHORT_BATCH', 'Selecciona de una a veinte conversaciones únicas del manifiesto.');
  }
  const cohortId = `clef-complement-${manifest.id}`, idempotencyKey = `${cohortId}:${index}`;
  if (state.jobs.some(job => job.idempotencyKey === idempotencyKey
    || (job.cohortId === cohortId && job.conversationIds.some(id => conversationIds.includes(id))))) {
    fail('DUPLICATE_EXECUTION', 'Este lote o alguna de sus conversaciones ya pertenece a la revisión complementaria.');
  }
  if (!sameCatalog(state.catalog, manifest.catalogVersions)) fail('CATALOG_CHANGED', 'El checklist cambió desde las evaluaciones de Gemma.');
  const entries = conversationIds.map(id => {
    const expected = manifest.conversations.find(c => c.id === id);
    const source = state.conversations.find(c => c.id === id);
    if (!source?.messages?.length || !sameContext(evaluationContext(source, state.catalog), expected)) {
      fail('SOURCE_CHANGED', 'El contenido o las reglas cambiaron; conserva la evaluación original y revisa ese caso por separado.');
    }
    const refs = state.operationalRefs.filter(ref => ref.id === id);
    const evaluation = refs.length === 1 && state.evaluations.find(e => e.id === refs[0].evaluationId);
    const originalTask = evaluation && state.tasks.find(task => task.id === evaluation.taskId);
    const originalJob = evaluation && state.jobs.find(job => job.id === evaluation.jobId);
    if (!evaluation || evaluation.conversationId !== id || evaluation.purpose !== 'operational' || evaluation.profileId !== 'gemma-local'
      || evaluation.requestedProfileId !== 'gemma-local' || evaluation.provider !== 'gateway' || evaluation.model !== gemmaProfile.model
      || evaluation.usedFallback || !evaluationMatchesProfile(evaluation, gemmaProfile) || !sameContext(evaluation, expected)
      || !sameCatalog(evaluation.catalogVersions, manifest.catalogVersions) || !Array.isArray(evaluation.results)
      || !originalTask || originalTask.jobId !== originalJob?.id || originalTask.conversationId !== id
      || originalTask.evaluationId !== evaluation.id || originalTask.profile?.id !== 'gemma-local'
      || !evaluationMatchesProfile(evaluation, originalTask.profile) || !sameContext(originalTask.context, expected)
      || !Array.isArray(originalTask.codeResults) || !['completed', 'partial'].includes(originalTask.status)
      || (originalTask.status === 'partial') !== (evaluation.partial === true)
      || originalJob?.purpose !== 'operational' || originalJob.maintenanceId !== manifest.id
      || !originalJob.conversationIds.includes(id) || !originalJob.modelProfiles.some(profile => profile.id === 'gemma-local' && evaluationMatchesProfile(evaluation, profile))) {
      fail('GEMMA_REFERENCE_CHANGED', 'La referencia operativa de Gemma no coincide con el manifiesto original.');
    }
    if (typeof expected.activityDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expected.activityDate)) {
      fail('INVALID_CLEF_COHORT', 'El manifiesto debe conservar la fecha de actividad de cada conversación.');
    }
    return { expected, evaluation, originalTask, originalJob };
  });
  const createdAt = new Date().toISOString(), jobId = randomUUID();
  const modelProfiles = structuredClone([gemmaProfile, clefProfile]);
  const tasks = entries.flatMap(({ expected, evaluation, originalTask, originalJob }) => {
    const shared = { jobId, conversationId: expected.id, fallback: null, context: contextOf(evaluation),
      codeResults: structuredClone(originalTask.codeResults) };
    return [{ ...shared, id: randomUUID(), profile: structuredClone(gemmaProfile), status: originalTask.status,
      round: 0, evaluationId: evaluation.id, error: structuredClone(originalTask.error || null),
      reusedEvaluationId: evaluation.id, reusedTaskId: originalTask.id, reusedJobId: originalJob.id },
    { ...shared, codeResults: structuredClone(shared.codeResults), context: { ...shared.context },
      id: randomUUID(), profile: structuredClone(clefProfile), status: 'pending', round: 0, evaluationId: null, error: null }];
  });
  const partial = entries.filter(entry => entry.originalTask.status === 'partial').length;
  const job = { id: jobId, purpose: 'comparison', mode: 'single', status: 'interrupted', scope: 'recheck', cohortId,
    maintenanceId: manifest.id, cohortManifestHash: manifest.integrityHash, cohortBatchIndex: index,
    sourceJobId: null, scheduleDate: null, from: null, to: null, country: null,
    total: conversationIds.length * 2, caseCount: conversationIds.length, completed: conversationIds.length - partial,
    failed: partial, partial, errors: entries.filter(entry => entry.originalTask.error).map(entry => ({
      conversationId: entry.expected.id, profileId: 'gemma-local', ...structuredClone(entry.originalTask.error) })),
    conversationIds: [...conversationIds], modelProfiles, fallback: null, concurrency: 1,
    policyVersion: state.settings.aiPolicy?.version ?? manifest.policyVersion,
    catalogVersions: structuredClone(manifest.catalogVersions), pendingOnly: false, demo: false,
    reusedTaskCount: conversationIds.length, newTaskCount: conversationIds.length,
    idempotencyKey, requestHash: digest({ cohortId, index, conversationIds, manifestHash: manifest.integrityHash,
      gemmaProfileHash: gemmaProfile.configurationHash, clefProfileHash: clefProfile.configurationHash,
      originalEvaluationIds: entries.map(entry => entry.evaluation.id) }),
    createdAt, updatedAt: createdAt, finishedAt: null };
  const sample = { id: jobId, name: `Gemma y Clef · lote ${index + 1}`, jobId, cohortId,
    modelProfiles: structuredClone(modelProfiles), catalogVersions: structuredClone(manifest.catalogVersions),
    createdAt, demo: false, authorName: 'Revisión complementaria autorizada',
    cases: entries.map(({ expected, evaluation, originalTask }) => ({ conversationId: expected.id,
      country: expected.country, date: expected.activityDate, ...contextOf(evaluation), codeResults: structuredClone(originalTask.codeResults) })) };
  return { job, tasks, sample };
}
