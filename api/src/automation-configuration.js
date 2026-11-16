import { z } from 'zod';
import { createHash } from 'node:crypto';
import { systemInstructions } from './evaluator.js';
import { AppError } from './errors.js';

export const AUTOMATION_MODELS = ['clef-local', 'gemma-local'];
export const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const countryCode = z.string().regex(/^[A-Z]{2}$/);
const positive = max => z.number().int().min(1).max(max);
const prompt = z.string().trim().min(1).max(30000);
const itemPromptSchema = z.object({
  mode: z.enum(['inherit', 'shared', 'per-model']), shared: z.string().trim().max(6000).default(''),
  byModel: z.object({ 'clef-local': z.string().trim().max(6000).default(''), 'gemma-local': z.string().trim().max(6000).default('') }).strict().default({}),
}).strict().superRefine((value, context) => {
  if (value.mode === 'shared' && !value.shared) context.addIssue({ code: 'custom', path: ['shared'], message: 'Escribe el prompt compartido del ítem.' });
  if (value.mode === 'per-model') for (const id of AUTOMATION_MODELS) if (!value.byModel[id]) context.addIssue({ code: 'custom', path: ['byModel', id], message: 'Escribe el prompt de cada modelo para este ítem.' });
});
export const automationSchema = z.object({
  enabled: z.boolean(), paused: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }),
  countries: z.array(z.object({ code: countryCode, name: z.string().trim().min(1).max(120), enabled: z.boolean(), paused: z.boolean(), dailyLimit: positive(100000) }).strict()).max(300)
    .refine(rows => new Set(rows.map(c => c.code)).size === rows.length, 'Un país solo puede configurarse una vez.'),
  selection: z.enum(['random', 'newest', 'oldest']), includeOpen: z.boolean(),
  executionOrder: z.enum(['parallel', 'model-first', 'conversation-first']),
  modelOrder: z.array(z.enum(AUTOMATION_MODELS)).length(2).refine(ids => new Set(ids).size === 2),
  pollSeconds: z.number().int().min(10).max(3600), blockSize: positive(100),
  concurrency: z.object({ 'clef-local': positive(3), 'gemma-local': positive(3) }).strict(),
  timeoutMs: z.object({ 'clef-local': z.number().int().min(1000).max(600000), 'gemma-local': z.number().int().min(1000).max(600000) }).strict(),
  retries: z.number().int().min(0).max(5), retryDelaysSeconds: z.array(positive(86400)).min(1).max(5),
  missingLoadMinutes: positive(1440),
  prompts: z.object({ mode: z.enum(['shared', 'per-model']), shared: prompt,
    byModel: z.object({ 'clef-local': prompt, 'gemma-local': prompt }).strict(),
    byItem: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/), itemPromptSchema).default({}) }).strict(),
}).strict();

export function automationConfiguration(settings = {}, countries = [], registry) {
  const saved = settings.automation;
  const bound = registry?.forState?.({ settings });
  const timeout = id => bound?.profiles.find(p => p.id === id)?.evaluator?.timeoutMs || 180000;
  const legacyCountries = settings.dailyCountries || [];
  const legacyOrder = settings.dailyModelIds;
  const defaults = {
    enabled: !!settings.dailyEnabled, paused: false, time: settings.dailyStartedAt ? settings.dailyTime || '00:01' : '00:01', timezone: settings.timezone || 'America/Tegucigalpa',
    countries: legacyCountries.map(code => ({ code, name: countries.find(c => c.code === code)?.name || code,
      enabled: true, paused: false, dailyLimit: settings.dailyLimitPerCountry || 100 })),
    selection: 'random', includeOpen: true, executionOrder: 'model-first',
    modelOrder: legacyOrder?.length === 2 && AUTOMATION_MODELS.every(id => legacyOrder.includes(id)) ? [...legacyOrder] : [...AUTOMATION_MODELS],
    pollSeconds: 60, blockSize: 20, concurrency: { 'clef-local': 1, 'gemma-local': 1 },
    timeoutMs: { 'clef-local': timeout('clef-local'), 'gemma-local': timeout('gemma-local') },
    retries: 2, retryDelaysSeconds: [30, 120], missingLoadMinutes: 60,
    prompts: { mode: 'shared', shared: systemInstructions, byItem: {}, byModel: { 'clef-local': systemInstructions, 'gemma-local': systemInstructions } },
  };
  const result = structuredClone(saved || defaults);
  result.prompts.byItem ||= {};
  for (const c of countries) if (/^[A-Z]{2}$/.test(c.code) && !result.countries.some(row => row.code === c.code)) {
    result.countries.push({ code: c.code, name: c.name, enabled: false, paused: false, dailyLimit: 100 });
  }
  return result;
}

export function runtimeConfiguration(configuration) {
  return Object.fromEntries(AUTOMATION_MODELS.map(id => [id, {
    promptText: configuration.prompts.mode === 'shared' ? configuration.prompts.shared : configuration.prompts.byModel[id],
    timeoutMs: configuration.timeoutMs[id],
    itemPrompts: Object.fromEntries(Object.entries(configuration.prompts.byItem || {}).filter(([, p]) => p.mode !== 'inherit').map(([key, p]) => [key, p.mode === 'shared' ? p.shared : p.byModel[id]])),
  }]));
}

export function saveAutomationConfiguration(state, input, author, countries = [], registry, date = new Date()) {
  const version = state.settings.version || 1;
  if (version !== input.expectedVersion) throw new AppError(409, 'La configuración cambió. Recarga antes de guardar.', 'VERSION_CONFLICT');
  if (state.settings.evaluationMaintenance) throw new AppError(409, 'Finaliza el mantenimiento antes de cambiar la configuración.', 'EVALUATION_MAINTENANCE');
  const next = automationSchema.parse(input.automation);
  if (Buffer.byteLength(JSON.stringify(next)) > 750000) throw new AppError(422, 'La configuración supera el tamaño permitido.', 'CONFIGURATION_TOO_LARGE');
  for (const id of Object.keys(next.prompts.byItem)) {
    const variable = state.catalog.find(v => v.id === id);
    if (!variable || !['IA', 'IA + código'].includes(variable.method) && next.prompts.byItem[id].mode !== 'inherit' && fingerprint(next.prompts.byItem[id]) !== fingerprint(state.settings.automation?.prompts?.byItem?.[id] || null)) throw new AppError(422, 'Los prompts por ítem requieren una variable del checklist evaluada con IA.', 'INVALID_PROMPT_ITEM');
  }
  const known = new Map([...automationConfiguration(state.settings, countries, registry).countries, ...countries].map(c => [c.code, c.name]));
  if (next.countries.some(c => !known.has(c.code))) throw new AppError(422, 'Selecciona países del catálogo de origen.', 'UNKNOWN_COUNTRY');
  next.countries = next.countries.map(c => ({ ...c, name: known.get(c.code) }));
  // Omitting an existing country must not silently erase its configuration.
  if ((state.settings.automation?.countries || []).some(c => !next.countries.some(n => n.code === c.code))) throw new AppError(422, 'Conserva los países existentes; puedes deshabilitarlos.', 'COUNTRY_REQUIRED');
  const previous = automationConfiguration(state.settings, countries, registry);
  const history = state.settings.automationHistory ||= [];
  if (!history.length) history.push({ version, configuration: previous, createdAt: date.toISOString(), author: 'Configuración anterior', source: 'migration' });
  state.settings.automation = next;
  state.settings.dailyEnabled = next.enabled;
  state.settings.dailyTime = next.time;
  state.settings.timezone = next.timezone;
  state.settings.dailyStartedAt ||= date.toISOString();
  state.settings.version = version + 1;
  state.settings.updatedAt = date.toISOString();
  state.settings.updatedBy = author.name;
  history.push({ version: version + 1, configuration: structuredClone(next), createdAt: date.toISOString(), author: author.name, authorId: author.id });
  return next;
}

export const automationSourceVersion = c => fingerprint([c.sourceDocumentId || null, c.sourceDocumentHash || null, c.completed !== false, c.sourceDocumentId ? null : c.sourceUpdatedAt || c.lastActivityAt || null]);
export const assignmentId = (date, country, conversationId) => fingerprint([date, country, conversationId]);
export function migrateDailyAssignments(state) {
  state.dailyAssignments ||= [];
  const existing = new Set(state.dailyAssignments.map(a => a.id));
  for (const job of state.jobs || []) {
    if (!job.dailyActivity || job.automation) continue;
    for (const conversationId of job.conversationIds || []) {
      const country = job.conversationCountries?.[conversationId] || state.conversations?.find(c => c.id === conversationId)?.country;
      if (!country) continue;
      const id = assignmentId(job.dailyActivity.date, country, conversationId);
      if (!existing.has(id)) {
        state.dailyAssignments.push({ id, activityDate: job.dailyActivity.date, country, conversationId,
          jobId: job.id, jobIds: [job.id], createdAt: job.createdAt, legacy: true });
        existing.add(id);
      }
    }
  }
}

// Transfer only work that was already selected by the previous daily scheduler.
// Its prompt/model/task contexts stay intact; one-off recoveries retain their owner.
export function adoptLegacyAutomationJobs(state) {
  migrateDailyAssignments(state);
  for (const job of state.jobs.filter(j => j.dailyActivity && !j.automation && !j.oneOffRun && j.status !== 'running')) {
    const pending = state.tasks.filter(t => t.jobId === job.id && !['completed', 'deferred'].includes(t.status));
    if (!pending.length) continue;
    const order = job.modelProfiles?.map(p => p.id);
    if (!order || order.length !== 2 || !AUTOMATION_MODELS.every(id => order.includes(id))) continue;
    const configuration = structuredClone(state.settings.automation);
    configuration.modelOrder = order; configuration.executionOrder = job.executionOrder || 'conversation-first';
    job.automation = { activityDate: job.dailyActivity.date, runDate: job.scheduleDate, configurationVersion: state.settings.version, configuration, legacy: true };
    job.conversationCountries ||= Object.fromEntries(state.dailyAssignments.filter(a => a.jobIds.includes(job.id)).map(a => [a.conversationId, a.country]));
    for (const task of pending) if (!task.error || ['AI_UNAVAILABLE', 'AI_TRANSIENT', 'AI_INCOMPLETE', 'AI_RESOURCE_LIMIT', 'SOURCE_CHANGED'].includes(task.error.code)) {
      task.status = 'pending'; task.automaticAttempts = 0;
    }
    job.status = 'queued'; job.finishedAt = null;
  }
}

export function reserveDailyAssignments(state, conversations, job) {
  migrateDailyAssignments(state);
  const { activityDate, configurationVersion, revisionOf } = job.automation;
  if (state.settings.version !== configurationVersion && !revisionOf) throw new AppError(409, 'La configuración cambió durante la selección.', 'SCHEDULE_CHANGED');
  const config = state.settings.automation;
  if (!config?.enabled || config.paused) throw new AppError(409, 'La automatización está pausada.', 'SCHEDULE_CHANGED');
  for (const c of conversations) {
    const policy = config.countries.find(row => row.code === c.country);
    if (!policy?.enabled || policy.paused) throw new AppError(409, 'El país está deshabilitado o pausado.', 'SCHEDULE_CHANGED');
    const id = assignmentId(activityDate, c.country, c.id);
    const existing = state.dailyAssignments.find(row => row.id === id);
    if (existing) {
      if (!revisionOf || existing.jobId !== revisionOf) throw new AppError(409, 'La conversación ya fue seleccionada.', 'DAILY_ALREADY_STARTED');
      existing.jobId = job.id; existing.jobIds.push(job.id); existing.sourceVersion = automationSourceVersion(c);
    } else {
      if (revisionOf) throw new AppError(409, 'No existe una selección para recuperar.', 'INVALID_RECHECK');
      const used = state.dailyAssignments.filter(row => row.activityDate === activityDate && row.country === c.country).length;
      if (used >= policy.dailyLimit) throw new AppError(409, 'El cupo del país ya fue asignado.', 'DAILY_ALREADY_STARTED');
      state.dailyAssignments.push({ id, activityDate, country: c.country, conversationId: c.id, jobId: job.id,
        jobIds: [job.id], createdAt: job.createdAt, sourceVersion: automationSourceVersion(c) });
    }
  }
}

export function countryCanRun(settings, country) {
  const config = settings.automation;
  const row = config?.countries.find(c => c.code === country);
  return !!(config?.enabled && !config.paused && row?.enabled && !row.paused && !settings.evaluationMaintenance);
}

export function recordAutomationAlert(settings, { id, type, message, country = null, modelId = null, activityDate = null }, now = new Date()) {
  const runtime = settings.automationRuntime ||= {};
  const alerts = runtime.alerts ||= [];
  const existing = alerts.find(a => a.id === id);
  if (existing) { Object.assign(existing, { type, message, country, modelId, activityDate, lastSeenAt: now.toISOString(), resolvedAt: null }); return; }
  alerts.push({ id, type, message, country, modelId, activityDate, createdAt: now.toISOString(), lastSeenAt: now.toISOString(), resolvedAt: null });
}
