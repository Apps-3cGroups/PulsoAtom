import { classificationOf, markKind } from './flags.js';

// Index once: dense month views must not scan the complete history for every day.
export function buildSummaryLanes(conversations, countries, days) {
  const daySet = new Set(days);
  const groups = new Map(countries.map(country => [country.code, { ...country, agents: new Map() }]));
  for (const conversation of conversations) {
    const group = groups.get(conversation.country);
    if (!group || !daySet.has(conversation.displayDate)) continue;
    const id = conversation.agent.id;
    if (!group.agents.has(id)) group.agents.set(id, { ...conversation.agent, byDay: Object.fromEntries(days.map(day => [day, []])) });
    group.agents.get(id).byDay[conversation.displayDate].push(conversation);
  }
  return [...groups.values()].filter(g => g.agents.size).map(group => ({ ...group, agents: [...group.agents.values()].map(agent => {
    for (const day of days) agent.byDay[day].sort((a, b) => b.displayAt.localeCompare(a.displayAt) || a.id.localeCompare(b.id));
    return agent;
  }) }));
}

// A busy day must not reduce every other day to subpixel-width cells.
export function compactDaySlots(timelineWidth, days) {
  return Math.max(1, Math.floor((Math.max(0, timelineWidth) / Math.max(1, days) - 3) / 9));
}

// Keep chronological order and every conversation, even when a day needs groups.
export function groupCompactDay(conversations, slots) {
  const count = Math.min(conversations.length, Math.max(1, Math.floor(slots)));
  return Array.from({ length: count }, (_, i) => conversations.slice(
    Math.floor(i * conversations.length / count), Math.floor((i + 1) * conversations.length / count),
  ));
}

const kindOrder = ['critical', 'normal', 'refuted', 'human', 'positive'];
export function compactMarks(conversations, { visible, variable, classification }) {
  const kinds = new Set();
  const names = new Set();
  for (const conversation of conversations) for (const mark of conversation.marks || []) {
    if (variable && mark.id !== variable || classification !== 'all' && classificationOf(mark) !== classification) continue;
    if (!(visible.includes(markKind(mark)) || visible.includes(classificationOf(mark)) && mark.effective)) continue;
    names.add(mark.name);
    for (const kind of mark.kind === 'refuted' ? ['refuted'] : [classificationOf(mark), ...(mark.origin === 'human' || mark.kind === 'human' ? ['human'] : [])]) {
      if (visible.includes(kind)) kinds.add(kind);
    }
  }
  return { kinds: kindOrder.filter(kind => kinds.has(kind)), names: [...names] };
}
