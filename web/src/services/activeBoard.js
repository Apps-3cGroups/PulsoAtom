import { classificationOf, flagCount, markKind } from './flags.js';
const markOrder = { critical: 0, p1: 0, normal: 1, p2: 1, human: 2, positive: 3, refuted: 4 };
export const visibleBoardMarks = conversation => conversation.marks.filter(mark => Object.hasOwn(markOrder, mark.kind) && mark.kind !== 'coaching').sort((a, b) => (markOrder[markKind(a)] ?? 4) - (markOrder[markKind(b)] ?? 4));
const rank = c => flagCount(c, 'critical') > 0 ? 0 : flagCount(c, 'normal') > 0 ? 1 : !c.evaluated || c.evaluationIncomplete ? 2 : 3;

// One box per assistant ID; names are not unique. Never merge across countries.
export function buildActiveBoard(conversations, country) {
  const groups = new Map();
  for (const conversation of conversations.filter(c => c.country === country)) {
    const key = conversation.agent.id;
    if (!groups.has(key)) groups.set(key, { agent: conversation.agent, conversations: [], flagged: 0, pending: 0 });
    const group = groups.get(key);
    group.conversations.push(conversation);
    if (flagCount(conversation, 'critical') || flagCount(conversation, 'normal') || conversation.human && !flagCount(conversation, 'positive')) group.flagged++;
    if (!conversation.evaluated || conversation.evaluationIncomplete) group.pending++;
  }
  for (const group of groups.values()) group.conversations.sort((a, b) => rank(a) - rank(b) || b.startedAt.localeCompare(a.startedAt) || String(a.id).localeCompare(String(b.id)));
  return [...groups.values()].sort((a, b) => rank(a.conversations[0]) - rank(b.conversations[0]) || a.agent.name.localeCompare(b.agent.name, 'es'));
}
