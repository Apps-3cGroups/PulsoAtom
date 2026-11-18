import { evaluationInstructions, systemInstructions, configurablePromptContract } from './evaluator.js';
import { z } from 'zod';
import { AppError } from './errors.js';
import { countries as demoCountries } from './data/seed.js';
import { automationConfiguration, automationSchema, saveAutomationConfiguration, migrateDailyAssignments, runtimeConfiguration } from './automation-configuration.js';
import { automationClock, refreshAutomationJob } from './automation-scheduler.js';
import { previousDate } from './daily-activity.js';

export function automationMonitor(state, activityDate) {
  const configuration = automationConfiguration(state.settings);
  const runtime = state.settings.automationRuntime || {};
  const date = activityDate || runtime.activityDate || previousDate(automationClock(new Date(), configuration.timezone).date);
  const day = runtime.days?.[date];
  const countries = runtime.activityDate !== date && day?.countries ? day.countries : configuration.countries;
  const assignments = (state.dailyAssignments || []).filter(a => a.activityDate === date);
  const rows = countries.map(country => {
    const selected = assignments.filter(a => a.country === country.code);
    const tasks = selected.flatMap(a => (state.tasks || []).filter(t => t.jobId === a.jobId && t.conversationId === a.conversationId && t.status !== 'deferred'));
    const available = day?.availability?.[country.code] ?? (runtime.activityDate === date ? runtime.availability?.[country.code] ?? null : null);
    return { ...country, available, selected: selected.length, outsideSample: available === null ? null : Math.max(0, available - selected.length),
      remaining: Math.max(0, country.dailyLimit - selected.length),
      models: Object.fromEntries(configuration.modelOrder.map(id => [id, {
        completed: tasks.filter(t => t.profile.id === id && t.status === 'completed').length,
        pending: tasks.filter(t => t.profile.id === id && t.status !== 'completed').length,
        failed: tasks.filter(t => t.profile.id === id && ['failed', 'partial'].includes(t.status)).length,
      }])),
    };
  });
  return { activityDate: date, enabled: configuration.enabled, paused: configuration.paused, configured: !!state.settings.automation,
    timezone: configuration.timezone, lastDetectionAt: runtime.lastDetectionAt || null,
    lastSuccessfulDetectionAt: day?.lastSuccessfulDetectionAt || (runtime.activityDate === date ? runtime.lastSuccessfulDetectionAt : null) || null, countries: rows,
    alerts: [...(runtime.alerts || [])].reverse(),
    jobs: state.jobs.filter(j => j.automation && (j.automation.activityDate === date || !['completed', 'failed', 'partial'].includes(j.status)))
      .map(j => ({ id: j.id, status: j.status, activityDate: j.automation.activityDate, executionOrder: j.executionOrder,
        configurationVersion: j.automation.configurationVersion, caseCount: j.caseCount, completed: j.completed, total: j.total,
        createdAt: j.createdAt, updatedAt: j.updatedAt, errors: j.errors, models: j.modelProfiles, nextAttemptAt: state.tasks.filter(t => t.jobId === j.id && t.status === 'retry_wait').map(t => t.nextAttemptAt).sort()[0] || null, promptVersion: j.promptSnapshot?.version || 'Anterior', promptHashes: Object.fromEntries(Object.entries(j.promptSnapshot?.profiles || {}).map(([id, p]) => [id, p.hash])) })) };
}

export function mountAutomationRoutes(app, prefix, { store, registry, requireAdmin, config }) {
  const catalog = async state => store.readCountryCatalog ? store.readCountryCatalog().catch(() => []) : state.countries || (config.demo ? demoCountries : []);
  const readConfiguration = () => store.readEvaluationConfiguration ? store.readEvaluationConfiguration() : store.read();
  const configurationTransaction = fn => store.evaluationConfigurationTransaction ? store.evaluationConfigurationTransaction(fn) : store.transaction(fn);
  app.get(`${prefix}/evaluations/settings`, requireAdmin, async (_req, res) => {
    const state = await readConfiguration();
    const countries = await catalog(state);
    res.set('Cache-Control', 'no-store').json({ settings: state.settings, automation: automationConfiguration(state.settings, countries, registry),
      countries, checklist: state.catalog.filter(v => !v.retired).map(({ id, name, method, type, active, definition, condition, version }) => ({ id, name, method, type, active, definition, condition, version })), configured: !!state.settings.automation, models: registry.forState(state).list(), demo: config.demo });
  });
  app.patch(`${prefix}/evaluations/settings`, requireAdmin, async (req, res, next) => {
    if (!Object.hasOwn(req.body, 'automation') && !Object.hasOwn(req.body, 'restoreVersion')) return next();
    const input = z.object({ expectedVersion: z.number().int().positive(), automation: automationSchema.optional(),
      restoreVersion: z.number().int().positive().optional(), restoreScope: z.enum(['all', 'prompts']).optional() }).strict()
      .refine(v => !!v.automation !== !!v.restoreVersion, 'Envía configuración o versión a restaurar.').parse(req.body);
    const before = await readConfiguration();
    const countries = await catalog(before);
    const result = await configurationTransaction(state => {
      if (input.restoreVersion) {
        const previous = state.settings.automationHistory?.find(h => h.version === input.restoreVersion);
        if (!previous) throw new AppError(404, 'No se encontró esta versión.', 'NOT_FOUND');
        const current = automationConfiguration(state.settings, countries, registry);
        input.automation = input.restoreScope === 'prompts' ? { ...current, prompts: structuredClone(previous.configuration.prompts) } : structuredClone(previous.configuration);
        for (const c of current.countries) if (!input.automation.countries.some(row => row.code === c.code)) input.automation.countries.push(c);
      }
      migrateDailyAssignments(state);
      const automation = saveAutomationConfiguration(state, input, req.user, countries, registry);
      if (input.restoreVersion) state.settings.automationHistory.at(-1).restoredFrom = input.restoreVersion;
      for (const job of state.jobs.filter(j => j.automation && j.status !== 'running')) refreshAutomationJob(state, job);
      return { settings: state.settings, automation, configured: true };
    });
    res.set('Cache-Control', 'no-store').json(result);
  });
  app.get(`${prefix}/evaluations/settings/history`, requireAdmin, async (_req, res) => {
    const settings = store.readSettings ? await store.readSettings() : (await store.read()).settings;
    res.set('Cache-Control', 'no-store').json({ items: [...(settings.automationHistory || [])].reverse() });
  });
  app.post(`${prefix}/evaluations/settings/preview`, requireAdmin, async (req, res) => {
    const { automation } = z.object({ automation: automationSchema }).strict().parse(req.body);
    const state = await readConfiguration();
    const runtime = runtimeConfiguration(automation);
    const bound = registry.forState(state).withRuntime(runtime);
    res.set('Cache-Control', 'no-store').json({ profiles: Object.keys(runtime).map(id => {
      const p = bound.profiles.find(p => p.id === id);
      return { id, label: id === 'clef-local' ? 'Clef' : 'Gemma', protocol: p?.evaluator.protocol || 'chat',
        itemPrompts: runtime[id].itemPrompts,
        ...(runtime[id].itemCriteria ? { itemCriteria: runtime[id].itemCriteria } : {}),
        text: p?.evaluator.effectiveInstructionsText || p?.evaluator.instructionsText || runtime[id].promptText + evaluationInstructions.slice(systemInstructions.length) + '\n\n' + configurablePromptContract };
    }) });
  });
  app.get(`${prefix}/evaluations/automation`, requireAdmin, async (req, res) => {
    const { activityDate } = z.object({ activityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict().parse(req.query);
    const state = store.readAutomationMonitorState ? await store.readAutomationMonitorState()
      : store.readAutomationState ? await store.readAutomationState() : await store.read();
    res.set('Cache-Control', 'no-store').json(automationMonitor(state, activityDate));
  });
  app.post(`${prefix}/evaluations/automation/control`, requireAdmin, async (req, res) => {
    const input = z.object({ expectedVersion: z.number().int().positive(), action: z.enum(['pause', 'resume']), country: z.string().regex(/^[A-Z]{2}$/).optional() }).strict().parse(req.body);
    const result = await configurationTransaction(state => {
      const automation = automationConfiguration(state.settings);
      if (!state.settings.automation) throw new AppError(409, 'Guarda primero la configuración de evaluaciones.', 'AUTOMATION_NOT_CONFIGURED');
      if (input.country) {
        const row = automation.countries.find(c => c.code === input.country);
        if (!row) throw new AppError(404, 'No se encontró el país.', 'NOT_FOUND');
        row.paused = input.action === 'pause';
      } else automation.paused = input.action === 'pause';
      saveAutomationConfiguration(state, { expectedVersion: input.expectedVersion, automation }, req.user);
      for (const job of state.jobs.filter(j => j.automation && j.status !== 'running')) refreshAutomationJob(state, job);
      return { settings: state.settings, automation, configured: true };
    });
    res.json(result);
  });
}
