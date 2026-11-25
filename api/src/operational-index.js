// Per-read indexes retain arrays in source order: duplicate records must still
// fail uniqueness checks, and find() must keep selecting the first match.
function grouped(rows, key) {
  const index = new Map();
  for (const row of rows || []) {
    const value = row[key];
    if (!index.has(value)) index.set(value, []);
    index.get(value).push(row);
  }
  return index;
}
function groupedPair(rows, first, second) {
  return new Map([...grouped(rows, first)].map(([key, values]) => [key, grouped(values, second)]));
}
export function operationalReadIndex(state, evaluationsById) {
  return { state, evaluations: evaluationsById || grouped(state.evaluations, 'id'),
    jobs: grouped(state.jobs, 'id'), cohorts: grouped(state.jobs, 'cohortId'),
    tasks: grouped(state.tasks, 'id'), tasksByJobConversation: groupedPair(state.tasks, 'jobId', 'conversationId'),
    conversations: grouped(state.conversations, 'id'), comparisons: grouped(state.comparisons, 'jobId'),
    catalogVersions: groupedPair(state.catalogVersions, 'itemId', 'version') };
}
