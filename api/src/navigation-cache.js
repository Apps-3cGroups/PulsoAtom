import { digest, sourceFingerprint } from './evaluation-context.js';

// Read-only navigation snapshots opt in explicitly. Evaluator transactions and
// detail/review routes never reuse these derived summaries.
const snapshots = new WeakMap();
const grouped = (rows, key) => {
  const result = new Map();
  for (const row of rows || []) { const id = key(row); if (!result.has(id)) result.set(id, []); result.get(id).push(row); }
  return result;
};
export function enableNavigationSummaryCache(state, cache, revisions = new WeakMap()) {
  const revision = row => revisions.get(row) || digest(row);
  const evaluations = grouped(state.evaluations, r => r.conversationId);
  const tasks = grouped(state.tasks, r => r.conversationId);
  const references = grouped(state.operationalRefs, r => r.id);
  const reviews = grouped(state.reviews, r => r.conversationId);
  const verdicts = grouped(state.verdicts, r => r.conversationId);
  const jobs = grouped(state.jobs, r => r.id), comparisons = grouped(state.comparisons, r => r.jobId);
  const catalog = digest([state.catalog, state.catalogVersions]);
  const inputs = new Map();
  for (const c of state.conversations) {
    const results = evaluations.get(c.id) || [], work = tasks.get(c.id) || [];
    const jobIds = [...new Set([...results, ...work].map(row => row.jobId).filter(Boolean))];
    inputs.set(c.id, digest([catalog, c, results.length ? sourceFingerprint(c) : null,
      results.map(revision), work.map(revision), (references.get(c.id) || []).map(revision),
      (reviews.get(c.id) || []).map(revision), (verdicts.get(c.id) || []).map(revision),
      jobIds.flatMap(id => (jobs.get(id) || []).map(revision)), jobIds.flatMap(id => (comparisons.get(id) || []).map(revision))]));
  }
  snapshots.set(state, { cache, inputs });
}
export function navigationSummaryCache(state, profileId) {
  const snapshot = snapshots.get(state);
  if (!snapshot) return null;
  const identity = id => `${id}:${profileId || 'operational'}`;
  return {
    get(id) { const item = snapshot.cache.get(identity(id)); return item?.revision === snapshot.inputs.get(id) ? { ...item.value } : null; },
    set(id, value) {
      snapshot.cache.set(identity(id), { revision: snapshot.inputs.get(id), value: { ...value } });
      while (snapshot.cache.size > 10000) snapshot.cache.delete(snapshot.cache.keys().next().value);
    },
  };
}
