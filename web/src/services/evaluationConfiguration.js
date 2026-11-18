// MySQL may return JSON object keys in a different order after a successful
// write. Verification must compare values while preserving meaningful arrays
// such as modelOrder and retry delays.
export function sameEvaluationConfiguration(left, right) {
  const serialize = value => JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  return serialize(left) === serialize(right);
}

export function automationActivation(configuration, now = new Date()) {
  const scheduled = !!configuration.startsAt && Date.parse(configuration.startsAt) > now.getTime();
  const label = !configuration.enabled ? 'Desactivada' : configuration.paused ? 'Pausada' : scheduled ? 'Programada' : 'Activada';
  return { label, scheduled, color: label === 'Activada' ? 'green' : label === 'Programada' ? 'blue' : 'default',
    startsAtText: scheduled ? new Intl.DateTimeFormat('es', { timeZone: configuration.timezone,
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(configuration.startsAt)) : null };
}
