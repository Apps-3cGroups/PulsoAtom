import { thursdayPriorityReleased } from './tuesday-wednesday-completion.js';
import { thursdayCoverage, THURSDAY_ACTIVITY, THURSDAY_INGESTION } from './thursday-handoff.js';
import { ingestionReadiness } from './one-off-evaluations.js';

// Read-only preflight. A completed import is not a promise of no later imports:
// the launcher grants only one Tuesday conversation before checking again.
export async function readDeferredTuesdayReadiness(store, now = new Date(), { coverage = thursdayCoverage } = {}) {
  const snapshot = await (store.readSchedulerState ? store.readSchedulerState() : store.read());
  const eligible = state => {
    const s = state.settings, p = s.tuesdayWednesdayCompletion?.priority;
    if (!thursdayPriorityReleased(s) || s.evaluationMaintenance) return 'RECOVERY_NOT_DEFERRED';
    if (p.tuesdayBlocked) return 'TUESDAY_REVIEW_REQUIRED';
    if (p.resumeTuesday !== 'automatic_before_noon') return 'TUESDAY_MANUAL_REVIEW_REQUIRED';
    if (!Number.isFinite(now.getTime()) || now.toISOString() >= p.deadline) return 'TUESDAY_DEADLINE_REACHED';
    if (!['caught_up', 'completed'].includes(s.thursdayHandoff?.status)) return 'THURSDAY_NOT_CAUGHT_UP';
    if (state.jobs.some(j => ['running', 'pending', 'queued'].includes(j.status))) return 'EVALUATION_RUNNING';
    return null;
  };
  let reason = eligible(snapshot);
  if (reason) return { ready: false, reason };
  if (!store.readIngestionSnapshot) return { ready: false, reason: 'INGESTION_UNAVAILABLE' };
  const ingestion = await store.readIngestionSnapshot(THURSDAY_INGESTION);
  if (!ingestionReadiness(ingestion, THURSDAY_INGESTION).ready) return { ready: false, reason: 'THURSDAY_INGESTION_PENDING' };
  // The production reader can limit transcript hydration to Thursday candidates.
  const overview = store.reader?.readOverview ? await store.reader.readOverview({ from: THURSDAY_ACTIVITY,
    dateBasis: 'activity', countries: ['HN', 'PA'] }, { metadataOnly: true }) : null;
  const state = await store.readWithConversations({ fresh: true,
    ...(overview ? { conversationIds: overview.conversations.map(c => c.id) } : {}) });
  reason = eligible(state);
  if (reason) return { ready: false, reason };
  if (state.settings.thursdayHandoff.scopeHash !== snapshot.settings.thursdayHandoff.scopeHash) return { ready: false, reason: 'HANDOFF_CHANGED' };
  const current = coverage(state, { ingestion });
  if (!current?.ingestionReady || !current.allReadyEvaluated || Object.keys(current.errors || {}).length
    || ['HN', 'PA'].some(country => !current.byCountry[country]?.eligibleConversations
      || current.byCountry[country].remainingConversations || current.byCountry[country].unavailableConversations)) {
    return { ready: false, reason: 'THURSDAY_PENDING', coverage: current };
  }
  return { ready: true, reason: null, checkedAt: now.toISOString(), handoffScopeHash: state.settings.thursdayHandoff.scopeHash, coverage: current };
}

export async function resumeDeferredTuesdayWhenReady(store, now = new Date(), operations = {}) {
  const readiness = await (operations.readiness || readDeferredTuesdayReadiness)(store, now);
  if (!readiness.ready) return null;
  // The launcher performs the same fresh preflight, then takes the private
  // launch lock and atomically claims maintenance before spawning its worker.
  const launch = operations.launch || (async () => {
    const { main } = await import('../scripts/complete-tuesday-wednesday.js');
    return main(['--resume-tuesday']);
  });
  return launch();
}
