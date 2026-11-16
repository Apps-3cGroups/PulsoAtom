// Civil time is presentation metadata. Never use it to change reporting days,
// stored UTC timestamps, evaluation fingerprints or automatic daily quotas.
const countryZones = Object.freeze({
  PA: 'America/Panama', HN: 'America/Tegucigalpa', GT: 'America/Guatemala',
  SV: 'America/El_Salvador', NI: 'America/Managua', CR: 'America/Costa_Rica',
  BZ: 'America/Belize', CO: 'America/Bogota', PE: 'America/Lima',
  BO: 'America/La_Paz', VE: 'America/Caracas', DO: 'America/Santo_Domingo',
  PR: 'America/Puerto_Rico', JM: 'America/Jamaica', CU: 'America/Havana',
  UY: 'America/Montevideo', PY: 'America/Asuncion',
});
// The agreed operational criterion for multi-zone countries is the capital.
const capitalZones = Object.freeze({
  MX: 'America/Mexico_City', CL: 'America/Santiago', EC: 'America/Guayaquil',
  AR: 'America/Argentina/Buenos_Aires', BR: 'America/Sao_Paulo',
  US: 'America/New_York', CA: 'America/Toronto', ES: 'Europe/Madrid',
});

export function validTimezone(value) {
  if (typeof value !== 'string' || !(value === 'UTC' || /^[A-Za-z_]+\/[A-Za-z_+\-/]+$/.test(value))) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}

export function parseCountryTimezones(value) {
  let zones;
  try { zones = value ? JSON.parse(value) : {}; } catch { throw new Error('COUNTRY_TIMEZONES debe ser un objeto JSON de país ISO a zona IANA.'); }
  if (!zones || Array.isArray(zones) || typeof zones !== 'object'
    || Object.entries(zones).some(([country, zone]) => !/^[A-Z]{2}$/.test(country) || !validTimezone(zone))) {
    throw new Error('COUNTRY_TIMEZONES requiere códigos ISO de dos letras mayúsculas y zonas IANA válidas.');
  }
  return Object.freeze(zones);
}

export function conversationTimezone(conversation, overrides = {}) {
  const country = String(conversation?.country || '').trim().toUpperCase();
  if (validTimezone(conversation?.displayTimezone)) return { displayTimezone: conversation.displayTimezone, displayTimezoneSource: 'conversation' };
  if (validTimezone(overrides[country])) return { displayTimezone: overrides[country], displayTimezoneSource: 'configured' };
  if (countryZones[country]) return { displayTimezone: countryZones[country], displayTimezoneSource: 'country' };
  if (capitalZones[country]) return { displayTimezone: capitalZones[country], displayTimezoneSource: 'capital' };
  return { displayTimezone: 'UTC', displayTimezoneSource: 'fallback' };
}
