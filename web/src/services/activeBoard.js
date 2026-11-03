const markOrder = { p1: 0, p2: 1, human: 2, refuted: 3 };
export const visibleBoardMarks = conversation => conversation.marks.filter(mark => Object.hasOwn(markOrder, mark.kind)).sort((a, b) => markOrder[a.kind] - markOrder[b.kind]);
const rank = c => c.p1 > 0 ? 0 : c.p2 > 0 || c.human > 0 ? 1 : !c.evaluated ? 2 : 3;

// One box per assistant ID; names are not unique. Never merge across countries.
export function buildActiveBoard(conversations, country) {
  const groups = new Map();
  for (const conversation of conversations.filter(c => c.country === country)) {
    const key = conversation.agent.id;
    if (!groups.has(key)) groups.set(key, { agent: conversation.agent, conversations: [], flagged: 0, pending: 0 });
    const group = groups.get(key);
    group.conversations.push(conversation);
    if (conversation.p1 || conversation.p2 || conversation.human) group.flagged++;
    if (!conversation.evaluated) group.pending++;
  }
  for (const group of groups.values()) group.conversations.sort((a, b) => rank(a) - rank(b) || b.startedAt.localeCompare(a.startedAt) || String(a.id).localeCompare(String(b.id)));
  return [...groups.values()].sort((a, b) => rank(a.conversations[0]) - rank(b.conversations[0]) || a.agent.name.localeCompare(b.agent.name, 'es'));
}
