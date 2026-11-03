import { api, ApiError } from './api.js';

export const scheduleValues = ({ dailyEnabled, dailyTime, timezone }) => ({ dailyEnabled, dailyTime, timezone });
export const sameSchedule = (a, b) => ['dailyEnabled', 'dailyTime', 'timezone'].every(key => a[key] === b[key]);
function settingsFrom(response) {
  const settings = response?.settings;
  if (!settings || !Number.isInteger(settings.version) || typeof settings.dailyEnabled !== 'boolean' || typeof settings.dailyTime !== 'string' || typeof settings.timezone !== 'string') {
    throw new ApiError('La respuesta no contiene una programación válida.', 0, 'INVALID_RESPONSE');
  }
  return settings;
}

// A lost response does not mean the write failed. Read back before offering a retry;
// never automatically repeat the PATCH, which can enable daily processing.
export async function verifySchedule(values, expectedVersion) {
  try {
    const settings = settingsFrom(await api('/evaluations/settings', { timeoutMs: 15000 }));
    const confirmed = settings.version > expectedVersion && sameSchedule(settings, values);
    return { status: confirmed ? 'confirmed' : settings.version > expectedVersion ? 'conflict' : 'unconfirmed', settings, verified: true };
  } catch (error) {
    if ([401, 403].includes(error.status)) throw error;
    return { status: 'unknown' };
  }
}

export async function saveSchedule(values, expectedVersion) {
  try {
    const settings = settingsFrom(await api('/evaluations/settings', { method: 'PATCH', body: { ...scheduleValues(values), expectedVersion }, timeoutMs: 20000 }));
    if (settings.version <= expectedVersion || !sameSchedule(settings, values)) throw new ApiError('No se pudo confirmar el cambio.', 0, 'INVALID_RESPONSE');
    return { status: 'confirmed', settings, verified: false };
  } catch (error) {
    if (error.status === 0 || error.status >= 500 || error.code === 'VERSION_CONFLICT' || (error.code === 'INVALID_RESPONSE' && error.status >= 200 && error.status < 300)) {
      return verifySchedule(values, expectedVersion);
    }
    throw error;
  }
}
