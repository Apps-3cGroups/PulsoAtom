import { AppError } from './errors.js';
import { digest, evaluationContext } from './evaluation-context.js';
import { DAILY_ACTIVITY_MODE, activityOnDate } from './daily-activity.js';
import { completedOperationalPair, dailyHandoffFor, assignedHandoffVersion } from './daily-equivalence.js';
import { COMPLETION_ID, COMPLETION_MODELS, assertCompletionPlan, assertCompletionStable, finalizedCompletion, completionTasks } from './tuesday-wednesday-completion.js';
import { RECOVERY_ID } from './gemma-incident-recovery.js';
import { ingestionReadiness } from './one-off-evaluations.js';

export const THURSDAY_ID = 'thursday-2026-11-12-after-recovery';
export const THURSDAY_ACTIVITY = '2026-11-12';
export const THURSDAY_RUN_DATE = '2026-11-13';
export const THURSDAY_NOT_BEFORE = '2026-11-13T06:01:00.000Z';
export const THURSDAY_INGESTION = Object.freeze({ countries: ['HN', 'PA'], ingestionFrom: '2026-11-13T06:00:00.000Z', expiresAt: '2026-11-14T06:00:00.000Z' });
const author = 'Mario Cruz · solicitud de carga completa del jueves';
const fail = (code, message) => { throw new AppError(409, message, code); };
const contract = h => ({ id: h.id, activityDate: h.activityDate, runDate: h.runDate, timezone: h.timezone,
  completionId: h.completionId, completionScopeHash: h.completionScopeHash, notBefore: h.notBefore,
  countries: h.countries, modelIds: h.modelIds, profiles: h.profiles, context: h.context, catalogDigest: h.catalogDigest,
  concurrency: h.concurrency, limitPerCountry: h.limitPerCountry });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const handoffHash = h => digest(canonical(contract(h)));
const contextOf = catalog => {
  const { sourceHash, ...context } = evaluationContext({ id: 'handoff-contract', messages: [] }, catalog);
  return context;
};
function completionGuard(state, registry, plan) {
  assertCompletionPlan(plan);
  if (plan.priorMaintenance !== null) fail('HANDOFF_PRIOR_MAINTENANCE', 'El mantenimiento anterior no permite iniciar automáticamente el jueves.');
  if (state.settings.tuesdayWednesdayCompletion?.id !== COMPLETION_ID) fail('COMPLETION_STATE_CHANGED', 'La recuperación esperada no está preparada.');
  if (state.settings.tuesdayWednesdayCompletion.status === 'completed') {
    if (!finalizedCompletion(state, registry, plan)) fail('COMPLETION_NOT_FINISHED', 'La recuperación aún no terminó.');
  } else assertCompletionStable(state, registry, plan);
}
export function assertThursdayRequest(state, registry, options) {
  if (!options.dailyActivity?.handoffId) return;
  const h = dailyHandoffFor(state.settings, options);
  if (!h || h.id !== THURSDAY_ID || h.activityDate !== THURSDAY_ACTIVITY || h.runDate !== THURSDAY_RUN_DATE
    || handoffHash(h) !== h.scopeHash || h.completionId !== COMPLETION_ID || h.limitPerCountry !== null
    || ![1, 2].includes(h.concurrency) || digest(options.countries) !== digest(h.countries)
    || digest(options.modelIds) !== digest(h.modelIds) || options.dailyActivity.timezone !== h.timezone
    || state.settings.tuesdayWednesdayCompletion?.id !== COMPLETION_ID
    || state.settings.tuesdayWednesdayCompletion.status !== 'completed' || state.settings.evaluationMaintenance) {
    fail('HANDOFF_NOT_READY', 'El jueves espera que termine la recuperación autorizada.');
  }
  if (digest(canonical(state.catalog)) !== h.catalogDigest || Object.entries(contextOf(state.catalog)).some(([key, value]) => h.context[key] !== value)) fail('CATALOG_CHANGED', 'El catálogo o las instrucciones cambiaron después de preparar el jueves.');
  const bound = registry.forState(state);
  for (const profile of h.profiles) bound.resolve(profile.id, profile);
}
export function withoutThursdayDuplicates(state, candidates, options) {
  const h = dailyHandoffFor(state.settings, options);
  return h ? candidates.filter(c => !completedOperationalPair(state, c, h.profiles)) : candidates;
}
export function thursdayRunDate(settings, now) {
  const h = settings.thursdayHandoff;
  return h?.id === THURSDAY_ID && h.status !== 'completed' && now.toISOString() >= h.notBefore ? h.runDate : null;
}
export async function prepareThursdayHandoff(store, registry, plan, { expectedVersion, expectedScopeHash, concurrency = 1, now = new Date() }) {
  return store.transaction(state => {
    if (state.metadata?.demo !== false) fail('REAL_MODE_REQUIRED', 'Se requiere la base real de Pulso.');
    if (state.settings.version !== expectedVersion) fail('VERSION_CONFLICT', 'La configuración cambió. Consulta su versión vigente.');
    if (expectedScopeHash !== plan.integrityHash) fail('COMPLETION_SCOPE_CHANGED', 'El alcance de la recuperación cambió.');
    completionGuard(state, registry, plan);
    if (![1, 2].includes(concurrency)) fail('INVALID_CONCURRENCY', 'Selecciona concurrencia 1 o 2.');
    if (concurrency === 2) {
      const rows = completionTasks(state, plan), ids = [...plan.tuesday, ...plan.wednesday].map(c => c.id);
      const completed = ids.filter(id => { const own = rows.filter(t => t.conversationId === id); return own.length === 2 && own.every(t => t.status === 'completed'); });
      if (state.settings.tuesdayWednesdayCompletion.concurrency !== 2 || completed.length < 10
        || rows.some(t => ['partial', 'failed'].includes(t.status) || t.error)) fail('CONCURRENCY_PILOT_REQUIRED', 'Primero verifica el piloto de dos evaluaciones sin errores.');
    }
    const old = state.settings.thursdayHandoff;
    if (old && old.id !== THURSDAY_ID) fail('HANDOFF_CHANGED', 'Existe otra entrega pendiente.');
    if (old && state.jobs.some(j => j.dailyActivity?.handoffId === old.id && j.status === 'running')) fail('EVALUATION_RUNNING', 'La ejecución del jueves ya está en curso.');
    const bound = registry.forState(state), profiles = COMPLETION_MODELS.map(id => bound.snapshot(bound.resolve(id)));
    if (profiles.some(p => p.provider !== 'gateway' || p.demo) || new Set(profiles.map(p => p.model)).size !== 2) fail('LOCAL_MODELS_REQUIRED', 'Se requieren Clef y Gemma locales y distintos.');
    const timestamp = now.toISOString();
    const handoff = { id: THURSDAY_ID, version: (old?.version || 0) + 1, status: 'prepared', activityDate: THURSDAY_ACTIVITY,
      runDate: THURSDAY_RUN_DATE, timezone: 'America/Tegucigalpa', completionId: COMPLETION_ID,
      completionScopeHash: plan.integrityHash, notBefore: THURSDAY_NOT_BEFORE, countries: ['HN', 'PA'], modelIds: [...COMPLETION_MODELS],
      profiles, context: contextOf(state.catalog), catalogDigest: digest(canonical(state.catalog)), limitPerCountry: null, concurrency,
      preparedAt: old?.preparedAt || timestamp, updatedAt: timestamp, approvedAt: timestamp, approvedBy: author };
    handoff.scopeHash = handoffHash(handoff);
    const settings = state.settings;
    const previous = { version: settings.version, dailyEnabled: settings.dailyEnabled, dailyMode: settings.dailyMode,
      dailyTime: settings.dailyTime, dailyStartDate: settings.dailyStartDate, dailyCatchupRunDate: settings.dailyCatchupRunDate,
      handoff: old ? { version: old.version, scopeHash: old.scopeHash, concurrency: old.concurrency } : null };
    settings.thursdayHandoff = handoff;
    settings.thursdayHandoffAudit = [...(settings.thursdayHandoffAudit || []), { action: old ? 'update' : 'prepare', author,
      timestamp, expectedVersion, expectedScopeHash, scopeHash: handoff.scopeHash, concurrency, previous }];
    Object.assign(settings, { dailyEnabled: true, dailyMode: DAILY_ACTIVITY_MODE, dailyTime: '00:01', timezone: handoff.timezone,
      dailyStartDate: settings.dailyStartDate && settings.dailyStartDate < THURSDAY_RUN_DATE ? settings.dailyStartDate : THURSDAY_RUN_DATE,
      dailyStartedAt: settings.dailyStartedAt || timestamp, dailyCountries: [...handoff.countries], dailyModelIds: [...handoff.modelIds],
      version: settings.version + 1, updatedAt: timestamp, updatedBy: author });
    // A stale incident catch-up must not take precedence over the prepared day.
    if (settings.dailyCatchupRunDate && settings.dailyCatchupRunDate !== THURSDAY_RUN_DATE) delete settings.dailyCatchupRunDate;
    for (const run of settings.oneOffEvaluations || []) if (run.id === 'friday-2026-11-13-hn-pa') {
      if (state.jobs.some(j => j.oneOffRun?.id === run.id)) fail('ONE_OFF_ALREADY_STARTED', 'La corrida de las 10:30 ya tiene una ejecución.');
      Object.assign(run, { executionSupersededBy: THURSDAY_ID, status: 'superseded', reason: 'Sustituida por la evaluación incremental completa del jueves.', updatedAt: timestamp });
    }
    return { id: handoff.id, status: handoff.status, settingsVersion: settings.version, scopeHash: handoff.scopeHash,
      completionScopeHash: plan.integrityHash, activityDate: handoff.activityDate, runDate: handoff.runDate,
      concurrency, limitPerCountry: null, approvedBy: author, approvedAt: timestamp, maintenanceRetained: settings.evaluationMaintenance === RECOVERY_ID };
  });
}
export function thursdayCoverage(state, { ingestion = null } = {}) {
  const h = state.settings.thursdayHandoff;
  if (!h) return null;
  const source = (state.conversations || []).filter(c => c.messages?.length && h.countries.includes(c.country) && activityOnDate(c, h.activityDate, h.timezone));
  const jobs = state.jobs.filter(j => j.dailyActivity?.handoffId === h.id);
  const assigned = new Set(jobs.flatMap(j => j.conversationIds));
  const options = { scheduleDate: h.runDate, dailyActivity: { handoffId: h.id, handoffScopeHash: h.scopeHash } };
  const byCountry = Object.fromEntries(h.countries.map(country => {
    const rows = source.filter(c => c.country === country), complete = rows.filter(c => completedOperationalPair(state, c, h.profiles));
    return [country, { readyConversations: rows.length, completedConversations: complete.length,
      reusedCompleted: complete.filter(c => !assigned.has(c.id)).length, remainingConversations: rows.length - complete.length,
      unassignedConversations: rows.filter(c => !assignedHandoffVersion(state, c, options, jobs) && !completedOperationalPair(state, c, h.profiles)).length }];
  }));
  const readiness = ingestion ? ingestionReadiness(ingestion, THURSDAY_INGESTION) : null;
  const errors = {};
  for (const task of state.tasks.filter(t => jobs.some(j => j.id === t.jobId) && t.error && t.status !== 'completed')) {
    const code = /^[A-Z_]{3,80}$/.test(task.error.code || '') ? task.error.code : 'EVALUATION_FAILED'; errors[code] = (errors[code] || 0) + 1;
  }
  return { byCountry, ingestionReady: readiness?.ready === true, missingCountries: readiness?.missing || h.countries,
    incompleteIngestionBatches: readiness?.unfinished.length ?? null, jobs: jobs.length,
    runningJobs: jobs.filter(j => j.status === 'running').length, errors,
    allReadyEvaluated: source.length > 0 && Object.values(byCountry).every(c => c.remainingConversations === 0) };
}
export function inspectThursdayHandoff(state, registry, plan, { ingestion = null, now = new Date() } = {}) {
  let blockedReason = null;
  try { completionGuard(state, registry, plan); } catch (error) { blockedReason = error.code || 'HANDOFF_BLOCKED'; }
  const h = state.settings.thursdayHandoff;
  const preview = h || { id: THURSDAY_ID, activityDate: THURSDAY_ACTIVITY, countries: ['HN', 'PA'],
    profiles: plan.profiles, timezone: 'America/Tegucigalpa' };
  return { checkedAt: now.toISOString(), readOnly: true, settingsVersion: state.settings.version,
    completionScopeHash: plan.integrityHash, completionId: COMPLETION_ID, completionStatus: state.settings.tuesdayWednesdayCompletion?.status,
    maintenanceActive: !!state.settings.evaluationMaintenance, priorMaintenanceClear: plan.priorMaintenance === null,
    preparationBlockedReason: blockedReason, activityDate: THURSDAY_ACTIVITY, runDate: THURSDAY_RUN_DATE,
    notBefore: THURSDAY_NOT_BEFORE, limitPerCountry: null, futureDailyLimitPerCountry: state.settings.dailyLimitPerCountry ?? null,
    status: h?.status || 'not_prepared', concurrency: h?.concurrency ?? null,
    scopeHash: h?.scopeHash || null, approvedBy: h?.approvedBy || null, approvedAt: h?.approvedAt || null,
    oneOffSuperseded: (state.settings.oneOffEvaluations || []).some(r => r.id === 'friday-2026-11-13-hn-pa' && r.executionSupersededBy === THURSDAY_ID),
    coverage: thursdayCoverage({ ...state, settings: { ...state.settings, thursdayHandoff: preview } }, { ingestion }) };
}
export async function reconcileThursdayHandoff(store, { now = new Date() } = {}) {
  const before = await (store.readSchedulerState ? store.readSchedulerState() : store.read());
  const h = before.settings.thursdayHandoff;
  if (!h || h.id !== THURSDAY_ID || h.status === 'completed' || before.settings.evaluationMaintenance
    || before.settings.tuesdayWednesdayCompletion?.status !== 'completed' || now.toISOString() < h.notBefore
    || before.jobs.some(j => j.status === 'running') || !store.readIngestionSnapshot) return false;
  const ingestion = await store.readIngestionSnapshot(THURSDAY_INGESTION);
  if (!ingestionReadiness(ingestion, THURSDAY_INGESTION).ready) return false;
  const state = await store.readWithConversations({ fresh: true });
  const coverage = thursdayCoverage(state, { ingestion });
  if (!coverage?.allReadyEvaluated) return false;
  return store.transaction(draft => {
    if (draft.settings.thursdayHandoff?.scopeHash !== h.scopeHash || draft.settings.evaluationMaintenance
      || draft.jobs.some(j => j.status === 'running')) return false;
    const checked = thursdayCoverage({ ...draft, conversations: state.conversations }, { ingestion });
    if (!checked.allReadyEvaluated) return false;
    // A completed batch is not proof that Automations will send no more batches.
    // Stay eligible throughout Friday, even when the currently loaded set is done.
    const status = now.toISOString() >= THURSDAY_INGESTION.expiresAt ? 'completed' : 'caught_up';
    Object.assign(draft.settings.thursdayHandoff, { status, ...(status === 'completed' ? { finishedAt: now.toISOString() } : {}), coverage: checked });
    return true;
  });
}
