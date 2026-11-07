import { pathToFileURL } from 'node:url';
import { AppError } from '../src/errors.js';
import { catalogReferences, digest, evaluationContext } from '../src/evaluation-context.js';
import { readRequiredBackfillManifest } from '../src/gemma-backfill.js';

export const ORIGINAL_GEMMA_MAINTENANCE_ID = '77f134e8-fdf8-4154-b1f6-485c159b9194';
export const ORIGINAL_GEMMA_MANIFEST = `/var/www/nodeapps/PulsoAtom/api/.data/backfills/${ORIGINAL_GEMMA_MAINTENANCE_ID}.json`;
const contextKeys = ['sourceHash', 'catalogHash', 'promptHash', 'rulesVersion'];
const sameContext = (actual, expected) => contextKeys.every(key => actual?.[key] && actual[key] === expected?.[key]);
const fail = code => { throw new AppError(409, 'No se pudo verificar la selección original de Gemma.', code); };
const key = value => String(value);
const active = row => ['running', 'queued', 'pending'].includes(row.status);
const recordHash = rows => digest([...rows].sort((a, b) => key(a.id).localeCompare(key(b.id))));

// Restore historical definitions in the manifest's original order. Current
// catalog activation never silently changes the checklist sent to Clef.
export function restoreClefCohortCatalog(state, manifest) {
  if (manifest?.id !== ORIGINAL_GEMMA_MAINTENANCE_ID || manifest.conversations?.length !== 500
    || new Set(manifest.conversations.map(c => key(c.id))).size !== 500
    || !manifest.catalogVersions?.length
    || new Set(manifest.catalogVersions.map(ref => ref.id)).size !== manifest.catalogVersions.length) fail('INVALID_CLEF_COHORT');
  return manifest.catalogVersions.map(ref => {
    const matches = state.catalogVersions.filter(version => version.itemId === ref.id && version.version === ref.version);
    if (matches.length !== 1 || !matches[0].snapshot || matches[0].snapshot.id !== ref.id
      || matches[0].snapshot.version !== ref.version) fail('MISSING_COHORT_CATALOG_VERSION');
    return { ...matches[0].snapshot, active: ref.active, retired: false };
  });
}

// Pure inspection. Return aggregates only: no IDs, transcript, evidence, model
// reasons, credentials or endpoints. The caller validates manifest integrity.
export function inspectClefCohort(state, manifest, registry) {
  const catalog = restoreClefCohortCatalog(state, manifest);
  const ids = new Set(manifest.conversations.map(c => key(c.id)));
  const source = new Map((state.conversations || []).map(c => [key(c.id), c]));
  const refs = new Map();
  for (const ref of state.operationalRefs || []) {
    if (!ids.has(key(ref.id))) continue;
    const list = refs.get(key(ref.id)) || []; list.push(ref); refs.set(key(ref.id), list);
  }
  const evaluations = new Map(state.evaluations.map(e => [e.id, e]));
  const tasks = new Map(state.tasks.map(t => [t.id, t]));
  const jobs = new Map(state.jobs.map(j => [j.id, j]));
  const models = registry.forState(state);
  const profiles = models.list();
  const gemma = profiles.find(p => p.id === 'gemma-local');
  const clef = profiles.find(p => p.id === 'clef-local');
  const counts = { total: 500, sourcePresent: 0, sourceMissing: 0, sourceChanged: 0, sourceEquivalent: 0,
    sourceContextChanged: 0, missingOperationalRef: 0, duplicateOperationalRef: 0,
    missingOperationalEvaluation: 0, operationalGemma: 0, operationalOtherModel: 0,
    gemmaComplete: 0, gemmaPartial: 0, gemmaIdentityMismatch: 0, gemmaContextMismatch: 0,
    gemmaCatalogMismatch: 0, gemmaTaskMismatch: 0, reusableGemma: 0,
    resultEvaluated: 0, resultAbstentions: 0, resultErrors: 0 };
  const originalCatalogHash = digest(catalogReferences(catalog));
  for (const entry of manifest.conversations) {
    const conversation = source.get(key(entry.id));
    let sourceEquivalent = false;
    if (!conversation) counts.sourceMissing++;
    else {
      counts.sourcePresent++;
      const context = evaluationContext(conversation, catalog);
      if (context.sourceHash !== entry.sourceHash) counts.sourceChanged++;
      else counts.sourceEquivalent++;
      if (!sameContext(context, entry)) counts.sourceContextChanged++;
      sourceEquivalent = sameContext(context, entry);
    }
    const selected = refs.get(key(entry.id)) || [];
    if (!selected.length) { counts.missingOperationalRef++; continue; }
    if (selected.length !== 1) { counts.duplicateOperationalRef++; continue; }
    const evaluation = evaluations.get(selected[0].evaluationId);
    if (!evaluation) { counts.missingOperationalEvaluation++; continue; }
    if (evaluation.profileId !== 'gemma-local') { counts.operationalOtherModel++; continue; }
    counts.operationalGemma++;
    evaluation.partial ? counts.gemmaPartial++ : counts.gemmaComplete++;
    const task = tasks.get(evaluation.taskId), job = jobs.get(evaluation.jobId);
    const identityMatch = key(evaluation.conversationId) === key(entry.id)
      && evaluation.purpose === 'operational' && evaluation.requestedProfileId === 'gemma-local'
      && evaluation.provider === manifest.profile.provider && evaluation.model === manifest.profile.model
      && !evaluation.usedFallback && evaluation.modelConfiguration?.configurationHash === manifest.profile.configurationHash;
    const contextMatch = sameContext(evaluation, entry);
    const catalogMatch = Array.isArray(evaluation.catalogVersions)
      && digest(catalogReferences(evaluation.catalogVersions)) === originalCatalogHash;
    const taskMatch = task && task.evaluationId === evaluation.id && task.jobId === evaluation.jobId
      && key(task.conversationId) === key(entry.id) && sameContext(task.context, entry)
      && task.profile?.id === 'gemma-local' && task.profile.configurationHash === manifest.profile.configurationHash
      && ['completed', 'partial'].includes(task.status) && job?.maintenanceId === manifest.id
      && job.purpose === 'operational' && job.mode === 'single'
      && job.modelProfiles?.length === 1 && job.modelProfiles[0].configurationHash === manifest.profile.configurationHash;
    if (!identityMatch) counts.gemmaIdentityMismatch++;
    if (!contextMatch) counts.gemmaContextMismatch++;
    if (!catalogMatch) counts.gemmaCatalogMismatch++;
    if (!taskMatch) counts.gemmaTaskMismatch++;
    if (sourceEquivalent && identityMatch && contextMatch && catalogMatch && taskMatch) counts.reusableGemma++;
    for (const result of evaluation.results || []) {
      if (result.error) counts.resultErrors++;
      else if (result.status === 'evaluado') counts.resultEvaluated++;
      else if (result.status === 'no_evaluado') counts.resultAbstentions++;
    }
  }
  const gemmaEvaluations = state.evaluations.filter(e => ids.has(key(e.conversationId)) && e.profileId === 'gemma-local');
  const gemmaTasks = state.tasks.filter(t => ids.has(key(t.conversationId)) && t.profile?.id === 'gemma-local');
  const gemmaTaskIds = new Set(gemmaTasks.map(t => t.id));
  const gemmaAttempts = state.attempts.filter(a => gemmaTaskIds.has(a.taskId));
  const safeProfile = p => p ? { id: p.id, provider: p.provider, model: p.model, enabled: p.enabled,
    configured: p.configured, configurationHash: p.configurationHash, protocol: p.protocol || 'chat',
    outputSchemaVersion: p.outputSchemaVersion || null, decisionInstructionsVersion: p.decisionInstructionsVersion || null } : null;
  const policy = models.policy(state);
  const currentContext = evaluationContext({ id: '__inspection__', messages: [] }, catalog);
  const checks = { realMode: state.metadata?.demo === false, dailyPaused: state.settings.dailyEnabled === false,
    originalMaintenanceActive: state.settings.evaluationMaintenance === manifest.id,
    originalGemmaConfiguration: gemma?.configurationHash === manifest.profile.configurationHash && gemma.enabled && gemma.configured,
    originalGemmaPolicy: policy.version === manifest.policyVersion && policy.mode === 'single'
      && policy.primaryId === 'gemma-local' && policy.secondaryId == null && policy.fallbackId == null,
    exactSourceScope: (state.conversations || []).every(c => ids.has(key(c.id)))
      && source.size === (state.conversations || []).length,
    originalCatalogHash: manifest.conversations.every(c => c.catalogHash === originalCatalogHash),
    instructionsEquivalent: manifest.conversations.every(c => c.promptHash === currentContext.promptHash && c.rulesVersion === currentContext.rulesVersion),
    noActiveJobs: !state.jobs.some(active), noRunningTasks: !state.tasks.some(t => t.status === 'running'),
    noRunningAttempts: !state.attempts.some(a => a.status === 'running'),
    allOriginalCasesReusable: counts.reusableGemma === 500 };
  return { readOnly: true, inferenceStarted: false, maintenanceId: manifest.id,
    manifestIntegrityHash: manifest.integrityHash, manifestStatus: manifest.status,
    settingsVersion: state.settings.version, localConfigurationVersion: state.settings.localModelConfiguration?.version || null,
    policy: { version: policy.version, mode: policy.mode, primaryId: policy.primaryId,
      secondaryId: policy.secondaryId ?? null, fallbackId: policy.fallbackId ?? null },
    profiles: { gemma: safeProfile(gemma), clef: safeProfile(clef) },
    checklist: { originalVariables: catalog.length, originalActive: catalog.filter(v => v.active).length,
      originalHash: originalCatalogHash, currentHash: digest(catalogReferences(state.catalog)),
      currentPromptHash: currentContext.promptHash, currentRulesVersion: currentContext.rulesVersion },
    counts, checks, readyForCohortAugmentation: Object.values(checks).every(Boolean),
    preserved: { gemmaEvaluations: gemmaEvaluations.length, gemmaTasks: gemmaTasks.length,
      gemmaAttempts: gemmaAttempts.length, gemmaEvaluationsHash: recordHash(gemmaEvaluations),
      gemmaTasksHash: recordHash(gemmaTasks), gemmaAttemptsHash: recordHash(gemmaAttempts) } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let store;
  try {
    if (process.argv.slice(2).some(argument => argument !== '--inspect') || process.argv.length > 3) fail('INVALID_ARGUMENTS');
    const [{ config, databaseConfig, atomDatabaseConfig }, { MysqlStore, AtomHistoryStore }, { AtomReader }, { registryFromEnv }] = await Promise.all([
      import('../src/config.js'), import('../src/store.js'), import('../src/atom.js'), import('../src/model-registry.js')]);
    const db = databaseConfig(), atom = atomDatabaseConfig();
    if (config.demo || db?.database !== 'dbPulsosAtom' || !atom) fail('REAL_CONFIGURATION_REQUIRED');
    const manifest = await readRequiredBackfillManifest(ORIGINAL_GEMMA_MANIFEST);
    if (manifest.id !== ORIGINAL_GEMMA_MAINTENANCE_ID || manifest.conversations.length !== 500
      || new Set(manifest.conversations.map(c => key(c.id))).size !== 500) fail('INVALID_CLEF_COHORT');
    store = new AtomHistoryStore(new MysqlStore(db), new AtomReader(atom, config.timezone));
    const state = await store.readWithConversations({ fresh: true, conversationIds: manifest.conversations.map(c => c.id) });
    console.log(JSON.stringify(inspectClefCohort(state, manifest, registryFromEnv()), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ readOnly: true, inferenceStarted: false, success: false,
      code: error instanceof AppError ? error.code : 'CLEF_COHORT_INSPECTION_FAILED',
      message: 'No se pudo verificar la cohorte; no se modificaron datos ni se ejecutó IA.' }));
    process.exitCode = 1;
  } finally { await store?.close(); }
}
