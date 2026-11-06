import { api, ApiError } from './api.js';

export const localProfileIds = ['clef-local', 'gemma-local'];
export const editableLocalProfiles = profiles => localProfileIds.map(id => {
  const profile = profiles.find(p => p.id === id) || {};
  return { id, toolKey: profile.toolKey || '', model: profile.model || '', enabled: !!profile.enabled,
    responseFormat: profile.responseFormat || 'json_schema' };
});
export const executableProfiles = (profiles, demo = false) => profiles.filter(p => !p.historical
  && (demo || (p.provider === 'gateway' && localProfileIds.includes(p.id))));
export const onlyDisablingLocalProfiles = (previous, next) => next.some(profile => previous.find(old => old.id === profile.id)?.enabled && !profile.enabled)
  && next.every(profile => {
    const old = previous.find(item => item.id === profile.id);
    return old && ['toolKey', 'model', 'responseFormat'].every(key => old[key] === profile[key]) && (!profile.enabled || old.enabled);
  });

export function policySelection(policy, profiles) {
  const available = profiles.filter(p => p.available);
  const has = id => available.some(p => p.id === id);
  const current = has(policy.primaryId) && (policy.mode === 'dual' ? has(policy.secondaryId)
    && policy.primaryId !== policy.secondaryId : !policy.fallbackId || has(policy.fallbackId));
  if (current) return { ...policy, pending: false };
  return { mode: 'dual', primaryId: available[0]?.id, secondaryId: available[1]?.id, fallbackId: null, pending: true };
}

export function localConfigurationMatches(saved, requested, expectedVersion) {
  if (!saved || !Number.isInteger(saved.version) || saved.version <= expectedVersion || !Array.isArray(saved.profiles)
    || saved.profiles.length !== 2 || typeof saved.gatewayConfigured !== 'boolean' || typeof saved.policyReady !== 'boolean') return false;
  return localProfileIds.every(id => {
    const actual = saved.profiles.find(p => p.id === id), wanted = requested.find(p => p.id === id);
    return actual && wanted && ['toolKey', 'model', 'enabled', 'responseFormat'].every(key => actual[key] === wanted[key]);
  });
}

export async function saveLocalConfiguration(profiles, expectedVersion) {
  let saved;
  try {
    saved = await api('/models/local-configuration', { method: 'PUT', body: { expectedVersion, profiles }, timeoutMs: 195000 });
    if (localConfigurationMatches(saved, profiles, expectedVersion)) return saved;
  } catch (error) {
    // Reconcile an uncertain write by reading; never blindly repeat the PUT.
    if (error.status && error.status < 500 && error.code !== 'INVALID_RESPONSE') throw error;
  }
  try {
    saved = await api('/models/local-configuration', { timeoutMs: 20000 });
    if (localConfigurationMatches(saved, profiles, expectedVersion)) return saved;
  } catch { /* Leave the draft available, without announcing a successful save. */ }
  throw new ApiError('No pudimos confirmar el guardado. Recarga la configuración antes de volver a guardar.', 0, 'LOCAL_SAVE_UNCONFIRMED');
}
