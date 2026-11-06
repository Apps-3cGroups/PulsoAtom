import { AppError } from './errors.js';

const fail = (code, message) => { throw new AppError(409, message, code); };
const operator = { id: 'cli-gemma-renewal', name: 'CLI · preparación Gemma autorizada' };
const active = job => ['running', 'pending', 'queued'].includes(job.status);

function configuration(state, registry) {
  if (state.metadata?.demo !== false) fail('REAL_MODE_REQUIRED', 'La preparación requiere la base real de Pulso.');
  const models = registry.forState ? registry.forState(state) : registry;
  const profile = models.resolve('gemma-local');
  if (profile.provider !== 'gateway' || profile.demo || !profile.model) fail('GEMMA_LOCAL_REQUIRED', 'Configura y habilita el perfil local de Gemma antes de preparar la renovación.');
  return { policy: models.policy(state), profile: models.snapshot(profile) };
}

// Inspection is pure and may report an incomplete Gateway configuration.
export function inspectGemmaRenewal(state, registry) {
  const models = registry.forState ? registry.forState(state) : registry;
  const policy = models.policy(state);
  let gemma = null, configurationError = null;
  try { gemma = configuration(state, registry).profile; }
  catch (error) { configurationError = error instanceof AppError ? error.code : 'GEMMA_CONFIGURATION_INVALID'; }
  const count = key => state[key]?.length || 0;
  return { readOnly: true, mode: state.metadata?.demo === false ? 'real' : 'demo',
    policy: { version: policy.version, mode: policy.mode, primaryId: policy.primaryId,
      secondaryId: policy.secondaryId ?? null, fallbackId: policy.fallbackId ?? null },
    gemma, configurationError, dailyEnabled: !!state.settings.dailyEnabled,
    maintenanceActive: !!state.settings.evaluationMaintenance,
    activeJobs: (state.jobs || []).filter(active).length,
    counts: { evaluations: count('evaluations'), operationalRefs: count('operationalRefs'), jobs: count('jobs'),
      tasks: count('tasks'), attempts: count('attempts'), comparisons: count('comparisons'),
      reviews: count('reviews'), humanVerdicts: count('verdicts'), validationSessions: count('validations'), exposures: count('exposures') } };
}

export async function prepareGemmaRenewal(store, registry, { expectedPolicyVersion, now = () => new Date().toISOString() } = {}) {
  if (!Number.isSafeInteger(expectedPolicyVersion) || expectedPolicyVersion < 1) fail('EXPECTED_VERSION_REQUIRED', 'Indica la versión de política observada con --expected-policy-version.');
  // No model calls and no catalog, profiles, results, or source data are changed.
  return store.transaction(state => {
    const { policy: current, profile } = configuration(state, registry);
    if (current.version !== expectedPolicyVersion) fail('VERSION_CONFLICT', 'La política cambió. Consulta --inspect y utiliza su versión actual.');
    if (state.settings.evaluationMaintenance) fail('EVALUATION_MAINTENANCE', 'Ya existe una renovación en mantenimiento; no se sustituye su política.');
    if ((state.jobs || []).some(active)) fail('EVALUATION_RUNNING', 'Hay evaluaciones en curso o en cola. Espera su finalización antes de preparar la renovación.');
    const alreadyPrepared = current.mode === 'single' && current.primaryId === 'gemma-local'
      && current.secondaryId == null && current.fallbackId == null && state.settings.dailyEnabled === false;
    if (alreadyPrepared) return { prepared: true, changed: false, ...inspectGemmaRenewal(state, registry), readOnly: false };
    const timestamp = now();
    state.modelPolicies ||= [];
    if (!state.modelPolicies.some(entry => entry.version === current.version)) state.modelPolicies.push({ id: String(current.version), ...current });
    const policy = { mode: 'single', primaryId: 'gemma-local', secondaryId: null, fallbackId: null,
      version: current.version + 1, updatedAt: timestamp, updatedBy: operator.name, updatedById: operator.id,
      reason: 'Renovación autorizada con Gemma; Clef pendiente de disponibilidad.' };
    if (state.modelPolicies.some(entry => entry.version === policy.version)) fail('POLICY_AUDIT_CONFLICT', 'La siguiente versión de política ya existe en la auditoría.');
    state.modelPolicies.push({ id: String(policy.version), ...policy });
    state.settings = { ...state.settings, aiPolicy: policy, dailyEnabled: false,
      gemmaRenewalPreparedAt: timestamp, gemmaRenewalPreparedBy: operator.id,
      gemmaRenewalConfigurationHash: profile.configurationHash, version: state.settings.version + 1 };
    return { prepared: true, changed: true, ...inspectGemmaRenewal(state, registry), readOnly: false };
  });
}
