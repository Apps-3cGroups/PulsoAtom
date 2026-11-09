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
