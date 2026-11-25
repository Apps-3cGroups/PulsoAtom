import { classificationOf, flagVariables } from './flags.js';

const asId = value => value === null || value === undefined || value === '' ? null : String(value);
const evidenceList = evidence => Array.isArray(evidence) ? evidence : evidence ? [evidence] : [];
const rank = variable => variable.kind === 'refuted' ? 3 : ({ critical: 0, normal: 1, positive: 2 }[classificationOf(variable)] ?? 4);
const orderFlags = variables => [...variables].sort((a, b) => rank(a) - rank(b)
  || (a.order ?? 0) - (b.order ?? 0) || String(a.name || '').localeCompare(String(b.name || ''), 'es'));
const isPositiveResult = result => result?.status === 'evaluado' && result.value === 1 && !result.error;

function flagEvidence(variable) {
  // conversationView already resolves the latest human verdict into `review`.
  // A human mark belongs to that person's selected evidence, not to an earlier
  // AI detection that may have cited a different message.
  if (variable.review?.action === 'levantar') return evidenceList(variable.review.evidence);
  const result = variable.result;
  const evidence = isPositiveResult(result) ? [...evidenceList(result.evidence)] : [];
  for (const cell of Array.isArray(result?.comparison?.cells) ? result.comparison.cells : []) {
    if (cell.error || ['failed', 'pending', 'running'].includes(cell.status) || !isPositiveResult(cell.result)) continue;
    evidence.push(...evidenceList(cell.result.evidence));
  }
  return evidence;
}

/** Resolve a saved citation to its unique original ID, never to another message. */
export function evidenceMessageLookup(conversation = {}) {
  const messages = new Map();
  for (const message of conversation.messages || []) {
    const id = asId(message.id);
    if (id !== null) messages.set(id, messages.has(id) ? null : message);
  }
  const changed = conversation.sourceChanged || conversation.evaluation?.sourceChanged;
  return evidence => {
    const message = messages.get(asId(evidence?.messageId));
    if (!message) return null;
    // Historical hashes may differ after actor/time corrections. A matching
    // citation links only that quoted text; it does not certify the whole source.
    // The evaluator stores the complete text, capped at 2,000 characters.
    if (changed && (typeof evidence?.quote !== 'string' || !evidence.quote.trim()
      || typeof message.text !== 'string' || !(message.text === evidence.quote
        || (evidence.quote.length === 2000 && message.text.startsWith(evidence.quote))))) return null;
    return message;
  };
}

/** Associate published marks with actual IDs and verify historical quotations. */
export function buildMessageFlags(conversation = {}) {
  const resolveEvidence = evidenceMessageLookup(conversation);
  const sourceChanged = conversation.sourceChanged || conversation.evaluation?.sourceChanged;
  const displayVariables = (conversation.variables || []).map(variable => sourceChanged && conversation.historicalFlagsAvailable === true
    && !variable.kind && variable.historicalAutomaticFlagVisible && variable.historicalKind
    ? { ...variable, kind: variable.historicalKind, historical: true } : variable);
  const seenVariables = new Set();
  const markedVariables = orderFlags(flagVariables(displayVariables).filter(variable => {
    const id = asId(variable.id);
    if (!variable.kind || id === null || seenVariables.has(id)) return false;
    seenVariables.add(id);
    return true;
  }));
  const byMessage = new Map();
  const unlinkedVariables = [];
  for (const variable of markedVariables) {
    const linkedIds = new Set(flagEvidence(variable)
      .map(evidence => asId(resolveEvidence(evidence)?.id)).filter(id => id !== null));
    if (!linkedIds.size) unlinkedVariables.push(variable);
    for (const id of linkedIds) {
      if (!byMessage.has(id)) byMessage.set(id, []);
      byMessage.get(id).push(variable);
    }
  }
  return { byMessage, markedVariables, unlinkedVariables };
}

function matchesClassification(variable, classification) {
  if (!classification || classification === 'all') return true;
  if (classification === 'refuted') return variable.kind === 'refuted';
  if (classification === 'human') return variable.kind !== 'refuted' && (variable.kind === 'human' || variable.origin === 'human');
  return classificationOf(variable) === classification;
}

/** Filters messages, retaining every attached mark on each visible message. */
export function filterMessageRows(messages = [], index, { onlyMarked = false, variableId = null, classification = 'all' } = {}) {
  const byMessage = index instanceof Map ? index : index?.byMessage;
  const selectedId = asId(variableId);
  const requireMatch = onlyMarked || selectedId !== null || (classification && classification !== 'all');
  return messages.flatMap(message => {
    const flags = byMessage?.get(asId(message.id)) || [];
    const matches = flags.some(variable => (selectedId === null || asId(variable.id) === selectedId)
      && matchesClassification(variable, classification));
    return !requireMatch || matches ? [{ message, flags }] : [];
  });
}

/** Grouped Ant Design Select options. Human marks retain the event's severity. */
export function groupFlagOptions(variables = []) {
  const groups = [
    { key: 'critical', label: 'Flag crítico' },
    { key: 'normal', label: 'Flag menor' },
    { key: 'positive', label: '+ Positivo' },
    { key: 'refuted', label: 'Refutados' },
  ];
  const seen = new Set();
  const flags = orderFlags(flagVariables(variables).filter(variable => {
    const id = asId(variable.id);
    if (!variable.kind || id === null || seen.has(id)) return false;
    seen.add(id);
    return true;
  }));
  return groups.map(group => ({ label: group.label, options: flags
    .filter(variable => (variable.kind === 'refuted' ? 'refuted' : classificationOf(variable)) === group.key)
    .map(variable => ({ value: asId(variable.id), label: variable.name })) })).filter(group => group.options.length);
}
