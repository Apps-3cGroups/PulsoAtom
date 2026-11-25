// Summary reads validate saved hashes, identities and each result value, but
// never execute frozen instructions or display evidence/reasons/retry buffers.
// Detail and workers continue to read the complete original payload.
const paths = {
  evaluations: [['promptSnapshot']],
  tasks: [['codeResults'], ['profileStates']],
  jobs: [['runtimeConfiguration'], ...['clef-local', 'gemma-local'].flatMap(profile =>
    ['text', 'itemPrompts', 'promptText'].map(field => ['promptSnapshot', 'profiles', profile, field]))],
};

export function navigationSummaryProjection(key) {
  const omitted = paths[key];
  if (!omitted) return 'payload';
  const base = `JSON_REMOVE(payload, ${omitted.map(path => `'$.${path.map(part => JSON.stringify(part)).join('.')}'`).join(', ')})`;
  if (key !== 'evaluations') return base;
  // JSON_ARRAYAGG does not guarantee order. Carry the original ordinal across
  // the wire so even duplicate/malformed historical entries keep their order.
  return `CASE WHEN JSON_TYPE(JSON_EXTRACT(payload, '$.results')) = 'ARRAY' THEN
    JSON_SET(${base}, '$.results', COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT(
      '_summaryPosition', item.position, '_summaryValue', JSON_REMOVE(item.result, '$.reason', '$.evidence', '$.aiResult')))
      FROM JSON_TABLE(payload, '$.results[*]' COLUMNS(position FOR ORDINALITY, result JSON PATH '$')) AS item), JSON_ARRAY()))
    ELSE ${base} END`;
}

export function decodeNavigationSummary(key, value) {
  if (key !== 'evaluations' || !Array.isArray(value?.results)) return value;
  value.results = value.results.sort((a, b) => a._summaryPosition - b._summaryPosition).map(item => item._summaryValue);
  return value;
}
