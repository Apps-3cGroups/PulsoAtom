// Test-only JSON_REMOVE semantics for the generated SQL; production performs
// this removal in MySQL, before transferring payloads over the connection.
export function jsonRemoveProjection(payload, expression) {
  const result = structuredClone(payload);
  for (const [, path] of expression.matchAll(/'(\$\.[^']+)'/g)) {
    if (['$.reason', '$.evidence', '$.aiResult', '$.results'].includes(path)) continue;
    const parts = path.includes('"') ? [...path.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(([part]) => JSON.parse(part)) : path.slice(2).split('.');
    const property = parts.pop();
    let current = result;
    for (const part of parts) current = current?.[part];
    if (current && typeof current === 'object') delete current[property];
  }
  if (expression.includes('JSON_TABLE(payload') && Array.isArray(result.results)) {
    result.results = result.results.map((value, index) => {
      const projected = structuredClone(value);
      if (projected && typeof projected === 'object') for (const key of ['reason', 'evidence', 'aiResult']) delete projected[key];
      return { _summaryPosition: index + 1, _summaryValue: projected };
    }).reverse(); // MySQL aggregation order is deliberately not assumed.
  }
  return result;
}
