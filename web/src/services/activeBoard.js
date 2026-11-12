import { classificationOf, flagCount, markKind, evaluationNeedsAttention, evaluationPending } from './flags.js';
import { queryString } from './api.js';
export const activeFigureKinds = ['critical', 'normal', 'positive'];
export function activeRequestPath({ countries, page, figures }) {
  const query = new URLSearchParams(queryString({ countries: countries.join(','), page, pageSize: 12 }));
  // Empty selection is meaningful: queryString intentionally drops empty strings.
  if (!activeFigureKinds.every(kind => figures.includes(kind))) query.set('figures', figures.join(','));
  return `/active?${query}`;
}
export const visibleActiveMarks = (conversation, selected = activeFigureKinds) => (conversation.marks || [])
  .filter(mark => mark.effective !== false && (['critical', 'normal', 'positive', 'human', 'p1', 'p2'].includes(mark.kind)
    || !mark.kind && activeFigureKinds.includes(mark.classification)) && selected.includes(classificationOf(mark)))
  .sort((a, b) => activeFigureKinds.indexOf(classificationOf(a)) - activeFigureKinds.indexOf(classificationOf(b)));
const markOrder = { critical: 0, p1: 0, normal: 1, p2: 1, human: 2, positive: 3, refuted: 4 };
export const visibleBoardMarks = conversation => conversation.marks.filter(mark => Object.hasOwn(markOrder, mark.kind) && mark.kind !== 'coaching').sort((a, b) => (markOrder[markKind(a)] ?? 4) - (markOrder[markKind(b)] ?? 4));
const rank = c => flagCount(c, 'critical') > 0 ? 0 : flagCount(c, 'normal') > 0 ? 1 : evaluationNeedsAttention(c) ? 2 : 3;

export const compareActiveConversations = (a, b) => rank(a) - rank(b) || b.startedAt.localeCompare(a.startedAt) || String(a.id).localeCompare(String(b.id));

// One box per assistant ID; names are not unique. Never merge across countries.
export function buildActiveBoard(conversations, country) {
  const groups = new Map();
  for (const conversation of conversations.filter(c => c.country === country)) {
    const key = conversation.agent.id;
    if (!groups.has(key)) groups.set(key, { agent: conversation.agent, conversations: [], flagged: 0, pending: 0 });
    const group = groups.get(key);
    group.conversations.push(conversation);
    if (flagCount(conversation, 'critical') || flagCount(conversation, 'normal') || conversation.human && !flagCount(conversation, 'positive')) group.flagged++;
    if (evaluationPending(conversation)) group.pending++;
  }
  for (const group of groups.values()) group.conversations.sort(compareActiveConversations);
  return [...groups.values()].sort((a, b) => rank(a.conversations[0]) - rank(b.conversations[0]) || a.agent.name.localeCompare(b.agent.name, 'es'));
}
