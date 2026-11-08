import { readFile, mkdir, cp, symlink, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { digest, evaluationContext } from '../src/evaluation-context.js';
import { startEvaluationBatch, evaluationModelProgress } from '../src/evaluation-service.js';
import { persistBackfillManifest, acquireBackfillLock } from '../src/gemma-backfill.js';
import { conversationView, viewContext } from '../src/domain.js';
import { AppError } from '../src/errors.js';
import { catalogV5 } from '../src/catalog-v5.js';

// One authorized, append-only cohort. Repeated --start never creates another job.
export const BATCH_ID = 'd530a03e-9182-47bf-8639-069f6f90e537';
export const PREVIOUS_ID = '77f134e8-fdf8-4154-b1f6-485c159b9194';
const productionApi = '/var/www/nodeapps/PulsoAtom/api';
const directory = `${productionApi}/.data/local-batches/${BATCH_ID}`;
const manifestFile = `${directory}/manifest.json`;
const modelIds = ['gemma-local', 'clef-local'];
const terminal = ['completed', 'partial', 'failed'];
const baselineFields = ['evaluations', 'tasks', 'attempts', 'jobs', 'comparisons', 'operationalRefs', 'reviews', 'verdicts'];
const fail = code => { throw Object.assign(new AppError(409, 'Operación detenida; no se modifica el histórico.', code), { batchCode: code }); };
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const code = error => error.batchCode || (/^[A-Z_]{3,80}$/.test(error.code || '') ? error.code : 'LOCAL_BATCH_FAILED');
const localDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Tegucigalpa', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));

export function newestUnevaluated(state, limit = 500) {
  const existing = new Set(state.evaluations.map(e => String(e.conversationId)));
  const activity = c => Number.isFinite(Date.parse(c.lastActivityAt)) ? Date.parse(c.lastActivityAt)
    : Math.max(...(c.messages || []).map(m => Date.parse(m.timestamp)).filter(Number.isFinite), Date.parse(c.startedAt) || 0);
  return state.conversations.filter(c => c.messages?.length && !existing.has(String(c.id)))
    .sort((a, b) => activity(b) - activity(a) || String(b.id).localeCompare(String(a.id), 'en', { numeric: true }))
    .slice(0, limit).map(c => ({ ...c, selectionActivityAt: new Date(activity(c)).toISOString() }));
}
export function originalRecords(state) {
  return Object.fromEntries(baselineFields.map(field => [field, (state[field] || []).map(row => ({ id: row.id, hash: digest(row) }))]));
}
export function originalsPreserved(state, baseline) {
  return Object.entries(baseline).every(([field, rows]) => {
    const current = new Map((state[field] || []).map(row => [row.id, row]));
    return rows.every(row => current.has(row.id) && digest(current.get(row.id)) === row.hash);
  });
}
const immutable = m => ({ format: m.format, id: m.id, createdAt: m.createdAt, profiles: m.profiles,
  policyHash: m.policyHash, catalogHash: m.catalogHash, conversations: m.conversations, baseline: m.baseline });
export function makePlan(state, registry) {
  if (state.metadata?.demo !== false) fail('REAL_MODE_REQUIRED');
  const bound = registry.forState(state);
  const profiles = modelIds.map(id => bound.snapshot(bound.resolve(id)));
  if (profiles.some(p => p.provider !== 'gateway' || p.demo) || new Set(profiles.map(p => p.model)).size !== 2) fail('LOCAL_MODELS_REQUIRED');
  const selected = newestUnevaluated(state);
  if (selected.length !== 500 || new Set(selected.map(c => c.id)).size !== 500) fail('INSUFFICIENT_NEW_CONVERSATIONS');
  const plan = { format: 1, id: BATCH_ID, createdAt: new Date().toISOString(), status: 'prepared', profiles,
    policyHash: digest(state.settings.aiPolicy), catalogHash: digest(state.catalog), baseline: originalRecords(state),
    conversations: selected.map(c => ({ id: c.id, activityAt: c.selectionActivityAt, ...evaluationContext(c, state.catalog) })) };
  plan.integrityHash = digest(immutable(plan));
  return plan;
}
export function assertPlan(manifest) {
  if (manifest?.format !== 1 || manifest.id !== BATCH_ID || manifest.conversations?.length !== 500
    || new Set(manifest.conversations.map(c => c.id)).size !== 500
    || digest(immutable(manifest)) !== manifest.integrityHash) fail('INVALID_MANIFEST');
}
function assertStable(state, registry, manifest) {
  assertPlan(manifest);
  if (state.settings.dailyEnabled !== false || state.settings.evaluationMaintenance !== BATCH_ID) fail('MAINTENANCE_CHANGED');
  if (digest(state.settings.aiPolicy) !== manifest.policyHash || digest(state.catalog) !== manifest.catalogHash) fail('CONFIGURATION_CHANGED');
  const bound = registry.forState(state);
  manifest.profiles.forEach(p => bound.resolve(p.id, p));
}
export function assertPreviousFinished(state, previous, workerAlive) {
  if (state.settings.dailyEnabled !== false) fail('DAILY_MUST_BE_PAUSED');
  if (state.jobs.some(j => ['running', 'queued', 'pending'].includes(j.status)) || state.tasks.some(t => t.status === 'running')
    || state.attempts.some(a => a.status === 'running')) fail('EVALUATION_RUNNING');
  const maintenance = state.settings.evaluationMaintenance;
  if (!maintenance) return;
  if (maintenance !== PREVIOUS_ID || previous?.cohortId !== `clef-complement-${PREVIOUS_ID}`
    || !['completed', 'partial'].includes(previous.status) || previous.finishedBatches !== 25 || !previous.finishedAt || workerAlive) fail('PREVIOUS_MAINTENANCE_NOT_FINISHED');
  const jobs = state.jobs.filter(j => j.cohortId === previous.cohortId);
  const tasks = state.tasks.filter(t => jobs.some(j => j.id === t.jobId));
  if (jobs.length !== 25 || tasks.length !== 1000 || tasks.some(t => !terminal.includes(t.status))) fail('PREVIOUS_COHORT_NOT_FINISHED');
}
export function assertFrozenConversations(state, manifest, ids, { requireUnevaluated = false } = {}) {
  assertPlan(manifest);
  const expectedById = new Map(manifest.conversations.map(c => [c.id, c]));
  const contextKeys = ['sourceHash', 'catalogHash', 'promptHash', 'promptVersion', 'rulesVersion'];
  for (const id of ids) {
    const expected = expectedById.get(id);
    const sources = state.conversations.filter(c => c.id === id);
    if (!expected || sources.length !== 1 || !sources[0].messages?.length) fail('SOURCE_CHANGED');
    const actual = evaluationContext(sources[0], state.catalog);
    if (contextKeys.some(key => !expected[key] || actual[key] !== expected[key])
      || (requireUnevaluated && state.evaluations.some(e => String(e.conversationId) === String(id)))) fail('SOURCE_CHANGED');
  }
}
export function existingCohortCoverage(state, previous) {
  if (!previous) return { available: false, reason: 'PREVIOUS_MANIFEST_MISSING' };
  const ids = previous.conversationIds;
  if (previous.cohortId !== `clef-complement-${PREVIOUS_ID}` || !Array.isArray(ids)
    || ids.length !== 500 || new Set(ids).size !== 500) fail('PREVIOUS_MANIFEST_INVALID');
  const context = viewContext(state), selected = new Set(ids);
  const views = state.conversations.filter(c => selected.has(c.id)).map(c => conversationView(state, c, context));
  const missing = ids.length - views.length;
  return { available: true, total: 500, sourceMissing: missing,
    evaluated: views.filter(v => v.evaluationStatus === 'evaluated').length,
    review_pending: views.filter(v => v.evaluationStatus === 'review_pending').length,
    partial: views.filter(v => v.evaluationStatus === 'partial').length,
    not_evaluated: views.filter(v => v.evaluationStatus === 'not_evaluated').length + missing,
    withAlerts: views.filter(v => v.critical || v.normal).length,
    withCritical: views.filter(v => v.critical).length,
    withNormal: views.filter(v => v.normal).length,
    withPositives: views.filter(v => v.positive).length,
    criticalFlags: views.reduce((total, v) => total + v.critical, 0),
    normalFlags: views.reduce((total, v) => total + v.normal, 0),
    positiveFlags: views.reduce((total, v) => total + v.positive, 0),
    withDualFlags: views.filter(v => v.dualDetected).length,
    dualFlags: views.reduce((total, v) => total + v.marks.filter(m => m.dualDetected).length, 0),
    sourceChanged: views.filter(v => v.sourceChanged).length };
}
export function batchStatus(state, manifest, workerAlive = alive(manifest.pid)) {
  assertPlan(manifest);
  const jobs = state.jobs.filter(j => j.idempotencyKey === BATCH_ID);
  if (jobs.length > 1) fail('DUPLICATE_BATCH');
  const job = jobs[0];
  const progress = job ? evaluationModelProgress(state, job) : modelIds.map(profileId => ({ profileId, total: 500, completed: 0, partial: 0, failed: 0, running: 0, pending: 500 }));
  const dates = manifest.conversations.map(c => localDate(c.activityAt)).sort();
  return { batchId: BATCH_ID, jobId: job?.id || null, status: manifest.status === 'blocked' ? 'blocked' : job?.status || manifest.status, workerAlive,
    totalConversations: 500, totalReviews: 1000, executionOrder: 'Gemma → Clef',
    activityFrom: dates[0], activityTo: dates.at(-1), timezone: 'America/Tegucigalpa',
    startedAt: manifest.startedAt || null, finishedAt: manifest.finishedAt || null, progress,
    originalRecordsPreserved: originalsPreserved(state, manifest.baseline), dailyPaused: state.settings.dailyEnabled === false,
    maintenanceActive: state.settings.evaluationMaintenance === BATCH_ID, errorCode: manifest.errorCode || null };
}

// Read-only diagnostics: whitelist every output field. Never expose provider
// messages, raw responses, variable reasons, conversation IDs or client data.
const auditErrorCodes = new Set(['AI_UNAVAILABLE', 'AI_TRANSIENT', 'AI_CONTEXT_LIMIT', 'AI_CONFIGURATION',
  'INVALID_AI_RESULT', 'AI_INCOMPLETE', 'AI_SAFETY_REFUSAL', 'INPUT_CAPACITY_EXCEEDED', 'UNSUPPORTED_INPUT',
  'SOURCE_CHANGED', 'CATALOG_CHANGED', 'MODEL_CHANGED', 'PROMPT_CHANGED', 'EVALUATION_FAILED',
  'MODEL_IDENTITY_UNVERIFIED', 'INVALID_MODEL_PROVENANCE', 'NATIVE_SCHEMA_MISMATCH', 'NATIVE_MODEL_MISMATCH']);
const auditVariableIds = new Set(catalogV5.map(v => v.id));
const auditValidationRules = new Set(['missing_item', 'invalid_status', 'invalid_value_type', 'invalid_reason', 'invalid_evidence_count',
  'unknown_evidence_message', 'missing_evidence', 'unexpected_evidence', 'inconsistent_status_value', 'unexpected_fields']);
const auditErrors = rows => {
  const counts = new Map();
  for (const row of rows) if (row.error) {
    const key = auditErrorCodes.has(row.error.code) ? row.error.code : 'OTHER';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
};
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const iso = value => value === null ? null : new Date(value).toISOString();
const auditProfileMatches = (a, b) => !!a && !!b && ['id', 'provider', 'model', 'configurationHash', 'protocol',
  'outputSchemaVersion', 'decisionInstructionsVersion', 'adapterVersion', 'instructionsHash'].every(key => (a[key] ?? null) === (b[key] ?? null));

export function localBatchAudit(state, manifest, observedAt = new Date().toISOString()) {
  assertPlan(manifest);
  const observed = timestamp(observedAt);
  if (observed === null) fail('INVALID_AUDIT_TIME');
  const jobs = state.jobs.filter(j => j.idempotencyKey === BATCH_ID);
  if (jobs.length > 1) fail('DUPLICATE_BATCH');
  const job = jobs[0], ids = new Set(manifest.conversations.map(c => c.id));
  const tasks = job ? state.tasks.filter(t => t.jobId === job.id) : [];
  if (job && (job.mode !== 'dual' || job.purpose !== 'operational'
    || job.conversationIds?.length !== 500 || new Set(job.conversationIds).size !== 500 || job.conversationIds.some(id => !ids.has(id))
    || job.modelProfiles?.length !== 2 || job.modelProfiles.some((p, i) => !auditProfileMatches(p, manifest.profiles[i]))
    || tasks.length !== 1000 || new Set(tasks.map(t => `${t.conversationId}:${t.profile?.id}`)).size !== 1000
    || new Set(tasks.map(t => t.id)).size !== 1000
    || tasks.some(t => !ids.has(t.conversationId) || !modelIds.includes(t.profile?.id)
      || !auditProfileMatches(t.profile, manifest.profiles.find(p => p.id === t.profile.id))))) fail('AUDIT_SCOPE_MISMATCH');
  const evaluationById = new Map(state.evaluations.map(e => [e.id, e]));
  const saved = tasks.filter(t => t.evaluationId).map(t => {
    const evaluation = evaluationById.get(t.evaluationId);
    if (!evaluation || evaluation.jobId !== job.id || evaluation.taskId !== t.id || evaluation.conversationId !== t.conversationId
      || evaluation.profileId !== t.profile.id || evaluation.usedFallback
      || !Array.isArray(evaluation.results) || new Set(evaluation.results.map(r => r.variableId)).size !== evaluation.results.length) fail('AUDIT_RESULT_MISMATCH');
    return { task: t, evaluation };
  });
  const source = state.conversations.filter(c => ids.has(c.id));
  if (new Set(source.map(c => c.id)).size !== source.length) fail('AUDIT_SOURCE_DUPLICATE');
  // Pin coverage to this cohort even if a newer operational job was run later.
  // This copy is in memory only; saved references and results remain untouched.
  const scoped = { ...state, conversations: source.map(c => ({ ...c, evaluationId: null })),
    operationalRefs: source.map(c => ({ id: c.id, evaluationId: saved.find(s => s.task.conversationId === c.id)?.evaluation.id || null })) };
  const context = viewContext(scoped), views = scoped.conversations.map(c => conversationView(scoped, c, context));
  const sourceMissing = 500 - views.length;
  const coverage = { total: 500, sourceMissing,
    evaluated: views.filter(v => v.evaluationStatus === 'evaluated').length,
    reviewPending: views.filter(v => v.evaluationStatus === 'review_pending').length,
    partial: views.filter(v => v.evaluationStatus === 'partial').length,
    notEvaluated: views.filter(v => v.evaluationStatus === 'not_evaluated').length + sourceMissing,
    sourceChanged: views.filter(v => v.sourceChanged).length,
    withSavedResults: views.filter(v => v.evaluated).length };
  const agreed = Object.fromEntries(['critical', 'normal', 'positive'].map(classification => {
    const counts = views.map(v => v.marks.filter(m => m.effective && m.dualDetected && m.classification === classification).length);
    return [classification, { flags: counts.reduce((n, count) => n + count, 0), conversations: counts.filter(Boolean).length }];
  }));
  agreed.conversations = views.filter(v => v.marks.some(m => m.effective && m.dualDetected)).length;
  agreed.attentionConversations = views.filter(v => v.marks.some(m => m.effective && m.dualDetected && ['critical', 'normal'].includes(m.classification))).length;
  const definitions = new Map(state.catalogVersions.map(v => [v.id, v.snapshot]));
  const models = modelIds.map(profileId => {
    const selected = tasks.filter(t => t.profile.id === profileId), taskIds = new Set(selected.map(t => t.id));
    const attempts = state.attempts.filter(a => a.jobId === job?.id && taskIds.has(a.taskId) && a.profileId === profileId);
    const evaluations = saved.filter(s => s.task.profile.id === profileId).map(s => s.evaluation);
    const results = evaluations.flatMap(e => e.catalogVersions.filter(ref => ref.active).flatMap(ref => {
      const definition = definitions.get(`${ref.id}:${ref.version}`);
      if (!definition) fail('MISSING_CATALOG_VERSION');
      return ['IA', 'IA + código'].includes(definition.method) ? e.results.filter(r => r.variableId === ref.id) : [];
    }));
    const expectedResults = evaluations.reduce((n, e) => n + e.catalogVersions.filter(ref => ref.active
      && ['IA', 'IA + código'].includes(definitions.get(`${ref.id}:${ref.version}`)?.method)).length, 0);
    const starts = attempts.map(a => timestamp(a.startedAt)).filter(t => t !== null);
    const finishes = attempts.map(a => timestamp(a.finishedAt)).filter(t => t !== null);
    const firstStarted = starts.length ? Math.min(...starts) : null, lastFinished = finishes.length ? Math.max(...finishes) : null;
    const finished = selected.length === 500 && selected.every(t => terminal.includes(t.status));
    const count = status => selected.filter(t => t.status === status).length;
    const variableErrors = new Map(), validationRules = new Map();
    for (const result of results.filter(r => r.error)) {
      if (auditVariableIds.has(result.variableId)) variableErrors.set(result.variableId, (variableErrors.get(result.variableId) || 0) + 1);
      for (const rule of new Set(Array.isArray(result.error.rules) ? result.error.rules : [])) {
        const key = auditValidationRules.has(rule) ? rule : 'OTHER';
        validationRules.set(key, (validationRules.get(key) || 0) + 1);
      }
    }
    const top = counts => [...counts.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, 5).map(([key, count]) => ({ key, count }));
    return { profileId, total: 500, completed: count('completed'), partial: count('partial'), failed: count('failed'), running: count('running'),
      pending: job ? selected.filter(t => ![...terminal, 'running'].includes(t.status)).length : 500,
      savedEvaluations: evaluations.length, firstStartedAt: iso(firstStarted), lastFinishedAt: iso(lastFinished),
      finishedAt: finished ? iso(lastFinished) : null,
      elapsedSeconds: firstStarted === null || (finished && lastFinished === null) ? null : Math.max(0, Math.round(((finished ? lastFinished : observed) - firstStarted) / 1000)),
      attemptCount: attempts.length, activeAttempts: attempts.filter(a => a.status === 'running').length,
      invalidAttemptTimestamps: attempts.filter(a => timestamp(a.startedAt) === null || (a.finishedAt != null && timestamp(a.finishedAt) === null)).length,
      taskErrors: auditErrors(selected), attemptErrors: auditErrors(attempts),
      aiResults: { expectedInSavedEvaluations: expectedResults, saved: results.length,
        evaluated: results.filter(r => r.status === 'evaluado' && !r.error).length,
        abstained: results.filter(r => r.status === 'no_evaluado' && r.value === null && !r.error).length,
        technicalErrors: results.filter(r => r.error).length, missing: expectedResults - results.length,
        errorCodes: auditErrors(results), topErrorVariables: top(variableErrors), topValidationRules: top(validationRules) } };
  });
  return { checkedAt: iso(observed), newCohortCoverage: coverage, agreed, models };
}
const readManifest = async () => { const m = JSON.parse(await readFile(manifestFile, 'utf8')); assertPlan(m); return m; };
async function optionalManifest() { try { return await readManifest(); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function previousManifest() {
  try { return JSON.parse(await readFile(`${productionApi}/.data/clef-cohort-${PREVIOUS_ID}/manifest.json`, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function inspect(store, registry) {
  const existing = await optionalManifest();
  const state = await store.readWithConversations({ fresh: true });
  const previous = await previousManifest();
  const coverage = existingCohortCoverage(state, previous);
  if (existing) return { readOnly: true, ...batchStatus(state, existing), existingCohortCoverage: coverage, ...localBatchAudit(state, existing) };
  assertPreviousFinished(state, previous, alive(previous?.pid));
  const plan = makePlan(state, registry);
  return { readOnly: true, ready: true, ...batchStatus(state, plan, false),
    models: plan.profiles.map(p => ({ profileId: p.id, model: p.model })),
    existingConversationsExcluded: new Set(state.evaluations.map(e => e.conversationId)).size, existingCohortCoverage: coverage };
}
async function start(store, registry) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquireBackfillLock(`${directory}/launch.lock`, BATCH_ID);
  try {
    const existing = await optionalManifest();
    if (existing) return { alreadyStarted: true, ...batchStatus(await store.read(), existing) };
    const state = await store.readWithConversations({ fresh: true });
    const previous = await previousManifest();
    assertPreviousFinished(state, previous, alive(previous?.pid));
    const manifest = makePlan(state, registry);
    // Keep executable source separate from deployment, without copying secrets or transcripts.
    const source = fileURLToPath(new URL('../', import.meta.url)), workerApi = `${directory}/worker-api`;
    await mkdir(workerApi, { mode: 0o700 });
    for (const entry of ['src', 'scripts', 'package.json']) await cp(path.join(source, entry), path.join(workerApi, entry), { recursive: true, errorOnExist: true, force: false,
      filter: filename => !['.env', 'node_modules', '.data'].includes(path.basename(filename)) });
    await symlink(`${productionApi}/node_modules`, `${workerApi}/node_modules`);
    await persistBackfillManifest(manifestFile, manifest);
    await store.transaction(draft => {
      assertPreviousFinished(draft, previous, alive(previous?.pid));
      if (!originalsPreserved(draft, manifest.baseline) || digest(draft.catalog) !== manifest.catalogHash
        || digest(draft.settings.aiPolicy) !== manifest.policyHash) fail('STATE_CHANGED_BEFORE_START');
      manifest.profiles.forEach(p => registry.forState(draft).resolve(p.id, p));
      draft.settings.evaluationMaintenance = BATCH_ID;
      draft.settings.version = (draft.settings.version || 0) + 1;
    });
    const log = await open(`${directory}/worker.log`, 'wx', 0o600);
    try {
      const child = spawn(process.execPath, [`--env-file=${productionApi}/.env`, `${workerApi}/scripts/start-next-local-batch.js`, '--worker'],
        { cwd: workerApi, env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      // Worker alone owns subsequent manifest writes; no launcher/worker race.
      return { started: true, batchId: BATCH_ID, workerPid: child.pid, totalConversations: 500, totalReviews: 1000,
        executionOrder: 'Gemma → Clef', dailyPaused: true };
    } finally { await log.close(); }
  } finally { await release(); }
}
async function worker(store, registry) {
  const release = await acquireBackfillLock(`${directory}/worker.lock`, BATCH_ID);
  let manifest;
  try {
    manifest = await readManifest();
    if (manifest.status !== 'prepared') fail('WORKER_ALREADY_STARTED');
    const state = await store.readWithConversations({ fresh: true, conversationIds: manifest.conversations.map(c => c.id) });
    assertStable(state, registry, manifest);
    if (!originalsPreserved(state, manifest.baseline)) fail('ORIGINAL_RECORD_CHANGED');
    assertFrozenConversations(state, manifest, manifest.conversations.map(c => c.id), { requireUnevaluated: true });
    Object.assign(manifest, { status: 'running', pid: process.pid, startedAt: new Date().toISOString() });
    await persistBackfillManifest(manifestFile, manifest);
    let initialRead = true;
    const guarded = { read: () => store.read(), async readWithConversations(options) {
      const fresh = await store.readWithConversations(options);
      assertStable(fresh, registry, manifest);
      assertFrozenConversations(fresh, manifest, options?.conversationIds || manifest.conversations.map(c => c.id), { requireUnevaluated: initialRead });
      initialRead = false;
      return fresh;
    },
      transaction: fn => store.transaction(draft => { assertStable(draft, registry, manifest); return fn(draft); }) };
    const { job, completion } = await startEvaluationBatch(guarded, registry, {
      purpose: 'operational', conversationIds: manifest.conversations.map(c => c.id), pendingOnly: true, refreshChanged: false,
      includeOpen: true, max: 500, largeBatch: true, maintenanceId: BATCH_ID, modelIds, executionOrder: 'model-first',
      concurrency: 1, idempotencyKey: BATCH_ID, author: { name: 'Lote autorizado Gemma → Clef', id: null } });
    manifest.jobId = job.id;
    await persistBackfillManifest(manifestFile, manifest);
    const result = await completion;
    await store.transaction(draft => {
      assertStable(draft, registry, manifest);
      const tasks = draft.tasks.filter(t => t.jobId === job.id);
      if (tasks.length !== 1000 || tasks.some(t => !terminal.includes(t.status))) fail('BATCH_NOT_FINISHED');
      if (!originalsPreserved(draft, manifest.baseline)) fail('ORIGINAL_RECORD_CHANGED');
      draft.settings.evaluationMaintenance = null;
      draft.settings.lastLocalBatchId = BATCH_ID;
      draft.settings.version = (draft.settings.version || 0) + 1;
    });
    Object.assign(manifest, { status: result.status, finishedAt: new Date().toISOString() });
    await persistBackfillManifest(manifestFile, manifest);
    console.log(JSON.stringify(batchStatus(await store.read(), manifest, false)));
  } catch (error) {
    if (manifest) { Object.assign(manifest, { status: 'blocked', errorCode: code(error), updatedAt: new Date().toISOString() }); await persistBackfillManifest(manifestFile, manifest); }
    throw error;
  } finally { await release(); }
}
async function main(args) {
  if (args.length !== 1 || !['--inspect', '--start', '--status', '--worker'].includes(args[0])) fail('INVALID_ARGUMENTS');
  const { config, databaseConfig, atomDatabaseConfig } = await import('../src/config.js');
  const { MysqlStore, AtomHistoryStore } = await import('../src/store.js');
  const { AtomReader } = await import('../src/atom.js');
  const { registryFromEnv } = await import('../src/model-registry.js');
  const db = databaseConfig(), atom = atomDatabaseConfig();
  if (config.demo || db?.database !== 'dbPulsosAtom' || (args[0] !== '--status' && !atom)) fail('REAL_MODE_REQUIRED');
  const store = args[0] === '--status' ? new MysqlStore(db) : new AtomHistoryStore(new MysqlStore(db), new AtomReader(atom, config.timezone));
  try {
    const registry = registryFromEnv();
    const result = args[0] === '--status' ? batchStatus(await store.read(), await readManifest())
      : args[0] === '--inspect' ? await inspect(store, registry) : args[0] === '--start' ? await start(store, registry) : await worker(store, registry);
    if (result) console.log(JSON.stringify(result, null, 2));
  } finally { await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ success: false, errorCode: code(error), message: 'Operación detenida. Revisar estado antes de reanudar; no se borraron evaluaciones.' }));
  process.exitCode = 1;
});
