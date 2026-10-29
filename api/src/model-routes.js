import { z } from 'zod';
import { AppError } from './errors.js';
import { ensureEvaluationState, exposeEvaluation, historicalProfileId } from './evaluation-context.js';
import { comparisonRows, findComparison, qualityMetrics, sampleSummary, saveValidation, validationView } from './comparisons.js';
import { startEvaluationBatch, resumeEvaluationBatch, recoverEvaluationJobs } from './evaluation-service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Fecha inválida');
const sampleSchema = z.object({ name: z.string().trim().min(3).max(100), modelIds: z.array(z.string().max(80)).min(2).max(3),
  from: date.optional(), to: date.optional(), country: z.string().max(10).optional(), max: z.number().int().min(1).max(20).default(20),
  conversationIds: z.array(z.string().max(200)).min(1).max(20).optional(), idempotencyKey: z.string().uuid() }).strict().refine(v => !v.from || !v.to || v.from <= v.to, 'Período inválido');
const validationSchema = z.object({ items: z.array(z.object({ variableId: z.string().max(160), expectedVerdictId: z.string().nullable(),
  outcome: z.enum(['present', 'absent', 'insufficient']), comment: z.string().trim().min(5).max(2000), messageId: z.string().max(200).optional() }).strict()).min(1).max(500) }).strict();
const reportFailure = completion => completion.catch(error => console.error('Error en ejecución de Pulso:', error.code || error.name));

export function mountModelRoutes(app, prefix, { store, registry, config, requireAdmin, readHistory, reviewHistory }) {
  const ready = () => { if (!config.demo && !store.readWithConversations) throw new AppError(409, 'Configura la lectura de Atom.', 'INTEGRATION_PENDING'); };
  app.get(`${prefix}/comparison-candidates`, async (req, res) => {
    const query = z.object({ q: z.string().max(200).optional(), country: z.string().max(10).optional(), from: date.optional(), to: date.optional() }).parse(req.query);
    const state = await readHistory();
    const candidates = state.conversations.filter(c => c.messages.length && c.completed !== false && (!query.country || c.country === query.country) && (!query.from || c.date >= query.from) && (!query.to || c.date <= query.to)
      && (!query.q || `${c.id} ${c.client.name} ${c.agent.name}`.toLowerCase().includes(query.q.toLowerCase())));
    res.json({ total: candidates.length, items: candidates.slice(0, 100).map(c => ({ id: c.id, clientName: c.client.name, country: c.country, date: c.date })) });
  });
  app.get(`${prefix}/models`, async (_req, res) => {
    const state = await store.read();
    const profiles = registry.list();
    for (const e of state.evaluations) {
      const id = historicalProfileId(e);
      if (!profiles.some(p => (p.viewId || p.id) === id)) profiles.push({ id, label: e.profileLabel || e.model || 'Evaluación histórica', model: e.model || null,
        provider: e.provider || 'legacy', available: false, enabled: false, configured: false, historical: true, demo: !!e.demo });
    }
    res.json({ profiles, policy: registry.policy(state), localStatus: 'Pendiente de definir infraestructura' });
  });
  app.patch(`${prefix}/models/policy`, requireAdmin, async (req, res) => {
    const input = z.object({ primaryId: z.string().max(80), fallbackId: z.string().max(80).nullable(), expectedVersion: z.number().int().positive() }).strict().parse(req.body);
    const primary = registry.resolve(input.primaryId), fallback = input.fallbackId ? registry.resolve(input.fallbackId) : null;
    if (fallback && primary.provider === fallback.provider && primary.model === fallback.model) throw new AppError(422, 'El respaldo debe ser otro modelo.', 'DUPLICATE_MODEL');
    const policy = await store.transaction(state => {
      ensureEvaluationState(state);
      const current = registry.policy(state);
      if (current.version !== input.expectedVersion) throw new AppError(409, 'La política cambió. Recarga antes de guardar.', 'VERSION_CONFLICT');
      if (!state.modelPolicies.some(p => p.version === current.version)) state.modelPolicies.push({ id: String(current.version), ...current });
      state.settings.aiPolicy = { primaryId: input.primaryId, fallbackId: input.fallbackId, version: current.version + 1, updatedAt: new Date().toISOString(), updatedBy: req.user.name, updatedById: req.user.id };
      state.modelPolicies.push({ id: String(state.settings.aiPolicy.version), ...state.settings.aiPolicy });
      return state.settings.aiPolicy;
    });
    res.json({ policy });
  });
  app.get(`${prefix}/comparisons`, async (req, res) => {
    await recoverEvaluationJobs(store);
    const state = ensureEvaluationState(await store.read());
    res.json({ items: [...state.comparisons].reverse().map(s => sampleSummary(state, s, req.user.id)) });
  });
  app.post(`${prefix}/comparisons`, requireAdmin, async (req, res) => {
    ready();
    const input = sampleSchema.parse(req.body);
    const { job, completion } = await startEvaluationBatch(store, registry, { ...input, purpose: 'comparison', random: !input.conversationIds, pendingOnly: false, author: req.user });
    reportFailure(completion); res.status(202).json({ job });
  });
  app.get(`${prefix}/comparisons/:id`, async (req, res) => {
    await recoverEvaluationJobs(store);
    const state = ensureEvaluationState(await readHistory(true));
    const sample = findComparison(state, req.params.id);
    const reveal = req.query.reveal === 'true';
    const selectedCase = typeof req.query.conversationId === 'string' ? req.query.conversationId : null;
    const visibleSample = selectedCase ? { ...sample, cases: sample.cases.filter(c => c.conversationId === selectedCase) } : sample;
    if (reveal) {
      await store.transaction(draft => { for (const c of visibleSample.cases) exposeEvaluation(draft, req.user.id, { ...c, catalogVersions: sample.catalogVersions }); });
    }
    const cases = sample.cases.map(c => {
      const source = state.conversations.find(s => s.id === c.conversationId);
      return { conversationId: c.conversationId, country: c.country, date: c.date, clientName: source?.client.name || c.conversationId,
        validated: state.validations.some(v => v.comparisonId === sample.id && v.conversationId === c.conversationId && v.authorId === req.user.id) };
    });
    const rows = reveal ? comparisonRows(state, visibleSample) : [];
    res.json({ ...sampleSummary(state, sample, req.user.id), cases, revealed: reveal, rows,
      metrics: reveal ? qualityMetrics(rows, sample.modelProfiles) : [],
      codeResults: reveal ? sample.cases.map(c => ({ conversationId: c.conversationId, results: c.codeResults })) : [] });
  });
  app.get(`${prefix}/comparisons/:id/validation/:conversationId`, async (req, res) => {
    const state = ensureEvaluationState(await readHistory(true));
    res.json(validationView(state, findComparison(state, req.params.id), req.params.conversationId, req.user));
  });
  app.post(`${prefix}/comparisons/:id/validation/:conversationId`, async (req, res) => {
    const input = validationSchema.parse(req.body);
    const validation = await reviewHistory(state => saveValidation(state, findComparison(state, req.params.id), req.params.conversationId, input, req.user));
    res.status(201).json({ validation });
  });
  app.post(`${prefix}/evaluations/:id/resume`, requireAdmin, async (req, res) => {
    ready(); z.object({}).strict().parse(req.body);
    const { job, completion } = await resumeEvaluationBatch(store, registry, req.params.id);
    reportFailure(completion); res.status(202).json({ job });
  });
  app.get(`${prefix}/evaluations/:id/attempts`, async (req, res) => {
    const state = ensureEvaluationState(await store.read());
    res.json({ tasks: state.tasks.filter(t => t.jobId === req.params.id), attempts: state.attempts.filter(a => a.jobId === req.params.id) });
  });
}
