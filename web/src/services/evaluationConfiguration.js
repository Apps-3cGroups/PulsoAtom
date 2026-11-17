// MySQL may return JSON object keys in a different order after a successful
// write. Verification must compare values while preserving meaningful arrays
// such as modelOrder and retry delays.
export function sameEvaluationConfiguration(left, right) {
  const serialize = value => JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  return serialize(left) === serialize(right);
}
