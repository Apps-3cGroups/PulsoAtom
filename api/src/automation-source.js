import { fingerprint } from './automation-configuration.js';

export function zonedDayBounds(date, timezone) {
  const midnight = text => {
    const target = Date.parse(`${text}T00:00:00Z`);
    let instant = target;
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    for (let i = 0; i < 4; i++) {
      const parts = formatter.formatToParts(new Date(instant));
      const part = type => parts.find(p => p.type === type).value;
      const represented = Date.parse(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`);
      const correction = target - represented;
      instant += correction;
      if (!correction) break;
    }
    return new Date(instant);
  };
  const next = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return { start: midnight(date), end: midnight(next) };
}

export function selectAutomationCandidates(source, assignments, configuration, activityDate) {
  const selected = [], groups = [];
  for (const country of configuration.countries.filter(c => c.enabled && !c.paused)) {
    const used = assignments.filter(a => a.activityDate === activityDate && a.country === country.code);
    const ids = new Set(used.map(a => a.conversationId));
    const remaining = Math.max(0, country.dailyLimit - ids.size);
    const candidates = source.filter(c => c.country === country.code && !ids.has(c.id)
      && (configuration.includeOpen || c.completed !== false));
    const stable = c => fingerprint([activityDate, country.code, c.id]);
    candidates.sort(configuration.selection === 'random' ? (a, b) => stable(a).localeCompare(stable(b))
      : (a, b) => ((Date.parse(a.lastActivityAt || a.date) || 0) - (Date.parse(b.lastActivityAt || b.date) || 0))
        * (configuration.selection === 'newest' ? -1 : 1) || a.id.localeCompare(b.id));
    groups.push(candidates.slice(0, remaining));
  }
  // Round-robin countries within a frozen selection, not one country's entire quota first.
  for (let i = 0; groups.some(group => i < group.length); i++) for (const group of groups) if (group[i]) selected.push(group[i]);
  return selected;
}
