import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { z, ZodError } from 'zod';
import { AppError } from './errors.js';
import { tokenHash, newToken, verifyPassword, publicUser, requireUser, requireAdmin } from './auth.js';
import { countries } from './data/seed.js';
import { createCatalogSchema, updateCatalogSchema, batchSchema, validateCatalog, saveCatalogVersion, ensureVersion, listQuerySchema, filteredConversations, summarize, priorityOrder, conversationView, viewContext, recordReview, reviewSchema } from './domain.js';
import { startEvaluationBatch, recoverEvaluationJobs } from './evaluation-service.js';
import { matchesSomos3cPassword } from './identity.js';
import { mountTdRoutes } from './td-routes.js';
import { registryFromEnv, asRegistry } from './model-registry.js';
import { mountModelRoutes } from './model-routes.js';
import { selectedEvaluation, exposeEvaluation, sourceFingerprint } from './evaluation-context.js';
import { normalizeBasePath } from './basePath.js';

const cookieName = 'pulso_session';
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) }).strict();
const externalLoginSchema = z.object({ username: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) }).strict();
const grantSchema = z.object({ externalId: z.number().int().positive(), role: z.enum(['admin', 'supervisor']) }).strict();
const settingsSchema = z.object({ dailyEnabled: z.boolean(), dailyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('es', { timeZone: value }); return true; } catch { return false; } }, 'Zona horaria inválida'), expectedVersion: z.number().int().positive() }).strict();
const evaluationRequestSchema = z.object({ scope: z.enum(['new', 'period']), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), max: z.number().int().min(1).max(20).default(20), idempotencyKey: z.string().uuid().optional() }).strict().refine(v => v.scope !== 'period' || (v.from && v.to && v.from <= v.to), 'Selecciona un período válido.');
export const integrationStatus = () => ({
  ready: process.env.OPENAI_EVALUATION_ENABLED === 'true' && !!(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL && process.env.ATOM_DB_HOST && process.env.APP_DB_HOST),
  atomConfigured: !!(process.env.ATOM_DB_HOST && process.env.ATOM_DB_NAME && process.env.ATOM_CONVERSATIONS_TABLE && process.env.ATOM_MESSAGES_TABLE && process.env.ATOM_COUNTRIES_TABLE),
  aiConfigured: !!(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL),
  blockers: [...(process.env.ATOM_DB_HOST && process.env.ATOM_DB_NAME && process.env.ATOM_COUNTRIES_TABLE ? [] : ['Configurar la lectura histórica de Atom.']), ...(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL ? [] : ['Configurar OpenAI para la evaluación.']), ...(process.env.OPENAI_EVALUATION_ENABLED === 'true' ? [] : ['La transferencia de conversaciones a OpenAI está deshabilitada.'])],
});

export function createApp(store, config, evaluator = registryFromEnv({ demo: config.demo }), identity = null, tdServices = {}) {
  const registry = asRegistry(evaluator);
  const status = () => ({ ...integrationStatus(), aiConfigured: registry.configured, ready: !config.demo && !!store.readWithConversations && registry.configured, blockers: registry.configured ? [] : ['Configura y habilita al menos un modelo de IA.'] });
  const basePath = normalizeBasePath(config.basePath);
  const prefix = `${basePath}/api`;
  const app = express();
  const externalUserId = id => `${identity?.mode === 'person-email' ? 'somos3c-person' : 'somos3c'}:${id}`;
  const readHistory = (fresh = false) => store.readWithConversations ? store.readWithConversations({ fresh }) : store.read();
  const reviewHistory = fn => store.transactionWithConversations ? store.transactionWithConversations(fn) : store.transaction(fn);
  app.disable('x-powered-by');
  app.use(helmet());
  const tdUploadPath = `${prefix}/integrations/td/s3/upload`;
  const tdMailPath = `${prefix}/integrations/td/mail/send`;
  const standardJson = express.json({ limit: '1mb' });
  app.use((req, res, next) => [tdUploadPath, tdMailPath].includes(req.path) ? next() : standardJson(req, res, next));
  app.use(cookieParser());
  app.use(prefix, (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('Origin');
      const allowed = [config.origin];
      if (config.demo && config.origin === 'http://127.0.0.1:3000') allowed.push('http://localhost:3000');
      if (origin && !allowed.includes(origin)) return next(new AppError(403, 'Origen de solicitud no autorizado.', 'INVALID_ORIGIN'));
      if (!req.is('application/json')) return next(new AppError(415, 'La solicitud debe usar JSON.', 'INVALID_CONTENT_TYPE'));
    }
    next();
  });
  app.get(`${prefix}/health`, async (_req, res) => {
    let storageReady = true;
    try { await store.read(); } catch { storageReady = false; }
    res.status(storageReady ? 200 : 503).json({ status: storageReady ? 'ok' : 'configuration_required', mode: config.demo ? 'demo' : 'real', storage: config.demo ? 'local_demo_file' : 'mysql', storageReady, evaluationReady: status().ready });
  });
  app.get(`${prefix}/meta`, (_req, res) => res.json({ name: 'Pulso', mode: config.demo ? 'demo' : 'real', authMode: identity?.mode === 'person-email' ? 'somos3c-email' : identity ? 'somos3c' : 'local', timezone: config.timezone, version: '0.1.0' }));
  app.use(prefix, async (req, _res, next) => {
    const token = req.cookies[cookieName];
    if (typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      const state = await store.read();
      const session = state.sessions.find(s => s.id === tokenHash(token) && Date.parse(s.expiresAt) > Date.now());
      const user = session && state.users.find(u => u.id === session.userId && u.active);
      if (user) {
        if (identity && user.externalId) {
          const source = await identity.byId(user.externalId);
          if (!source?.active || source.changeRequired || source.blocked || (!user.externalGrant && !source.sourceRoles.includes('super_admin'))) return next();
          req.user = publicUser({ ...user, role: source.sourceRoles.includes('super_admin') ? 'admin' : user.role, name: source.name });
        } else req.user = publicUser(user);
        req.sessionId = session.id;
      }
    }
    next();
  });
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: config.secureCookie, path: basePath, maxAge: config.sessionHours * 3600000 };
  async function signIn(req, res, user) {
    const token = newToken();
    await store.transaction(state => {
      state.sessions = state.sessions.filter(s => Date.parse(s.expiresAt) > Date.now() && s.id !== req.sessionId);
      state.sessions.push({ id: tokenHash(token), userId: user.id, expiresAt: new Date(Date.now() + cookieOptions.maxAge).toISOString() });
    });
    res.cookie(cookieName, token, cookieOptions).json({ user: publicUser(user), mode: config.demo ? 'demo' : 'real' });
  }
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'RATE_LIMIT', message: 'Demasiados intentos. Intenta de nuevo en unos minutos.' } } });
  app.post(`${prefix}/auth/demo`, loginLimiter, async (req, res) => {
    if (!config.demo) throw new AppError(404, 'La demostración está deshabilitada.');
    const { role } = z.object({ role: z.enum(['admin', 'supervisor']) }).strict().parse(req.body);
    const state = await store.read();
    const user = state.users.find(u => u.id === `demo-${role}` && u.active);
    if (!user) throw new AppError(503, 'La cuenta de demostración no está disponible.');
    await signIn(req, res, user);
  });
  app.post(`${prefix}/auth/login`, loginLimiter, async (req, res) => {
    if (config.demo) throw new AppError(409, 'Usa uno de los accesos de demostración.');
    if (identity) {
      const input = externalLoginSchema.parse(req.body);
      const source = await identity.lookup(input.username, { credentials: true });
      if (!source || !matchesSomos3cPassword(source.passwordHash, input.password)) throw new AppError(401, 'Usuario o contraseña incorrectos.', 'INVALID_CREDENTIALS');
      if (!source.active || source.blocked) throw new AppError(403, 'La cuenta de origen está inactiva o bloqueada.', 'SOURCE_ACCOUNT_BLOCKED');
      if (source.changeRequired) throw new AppError(403, 'Debes actualizar tu contraseña en el portal de origen antes de entrar a Pulso.', 'PASSWORD_CHANGE_REQUIRED');
      const user = await store.transaction(state => {
        const id = externalUserId(source.id);
        let current = state.users.find(item => item.id === id);
        const sourceAdmin = source.sourceRoles.includes('super_admin');
        if (!sourceAdmin && (!current?.externalGrant || !current.active)) throw new AppError(403, 'Tu usuario aún no tiene acceso a Pulso.', 'PULSO_ACCESS_REQUIRED');
        if (!current) {
          current = { id, externalId: source.id, externalGrant: false, email: `${id.replace(':', '-')}@pulso.local`, name: source.name, role: 'admin', active: true, createdAt: new Date().toISOString() };
          state.users.push(current);
        }
        current.name = source.name;
        if (sourceAdmin) current.active = true;
        return { ...current, role: sourceAdmin ? 'admin' : current.role };
      });
      return signIn(req, res, user);
    }
    const input = loginSchema.parse(req.body);
    const state = await store.read();
    const user = state.users.find(u => u.email.toLowerCase() === input.email.toLowerCase() && u.active);
    if (!verifyPassword(input.password, user?.passwordHash)) throw new AppError(401, 'Correo o contraseña incorrectos.', 'INVALID_CREDENTIALS');
    await signIn(req, res, user);
  });
  app.get(`${prefix}/auth/me`, requireUser, (req, res) => res.json({ user: req.user, mode: config.demo ? 'demo' : 'real' }));
  app.post(`${prefix}/auth/logout`, async (req, res) => {
    if (req.sessionId) await store.transaction(state => { state.sessions = state.sessions.filter(s => s.id !== req.sessionId); return null; });
    res.clearCookie(cookieName, { path: basePath, httpOnly: true, sameSite: 'strict', secure: config.secureCookie }).status(204).end();
  });
  app.use(prefix, requireUser);
  mountModelRoutes(app, prefix, { store, registry, config, requireAdmin, readHistory, reviewHistory });
  mountTdRoutes(app, prefix, requireAdmin, { enabled: !config.demo, ...tdServices });
  app.get(`${prefix}/access/grants`, requireAdmin, async (_req, res) => {
    if (!identity) throw new AppError(409, 'La identidad externa no está configurada.', 'INTEGRATION_PENDING');
    const state = await store.read();
    res.json({ items: state.users.filter(user => user.externalId && user.externalGrant).map(({ id, externalId, name, role, active }) => ({ id, externalId, name, role, active })) });
  });
  app.post(`${prefix}/access/lookup`, requireAdmin, async (req, res) => {
    if (!identity) throw new AppError(409, 'La identidad externa no está configurada.', 'INTEGRATION_PENDING');
    const { username } = z.object({ username: z.string().trim().min(1).max(254) }).strict().parse(req.body);
    const source = await identity.lookup(username);
    if (!source) throw new AppError(404, 'No se encontró el usuario en Somos3C.', 'NOT_FOUND');
    res.json({ user: { id: source.id, username: source.username, name: source.name, active: source.active, changeRequired: source.changeRequired, blocked: source.blocked } });
  });
  app.post(`${prefix}/access/grants`, requireAdmin, async (req, res) => {
    if (!identity) throw new AppError(409, 'La identidad externa no está configurada.', 'INTEGRATION_PENDING');
    const input = grantSchema.parse(req.body);
    const source = await identity.byId(input.externalId);
    if (!source?.active) throw new AppError(422, 'El usuario de origen no está activo.', 'SOURCE_ACCOUNT_BLOCKED');
    if (source.sourceRoles.includes('super_admin')) throw new AppError(409, 'El superadministrador de origen ya tiene acceso administrativo.', 'SOURCE_ADMIN');
    const grant = await store.transaction(state => {
      const id = externalUserId(source.id);
      let user = state.users.find(item => item.id === id);
      if (!user) { user = { id, externalId: source.id, email: `${id.replace(':', '-')}@pulso.local`, createdAt: new Date().toISOString() }; state.users.push(user); }
      Object.assign(user, { name: source.name, role: input.role, active: true, externalGrant: true, updatedBy: req.user.id, updatedAt: new Date().toISOString() });
      return { id, externalId: source.id, name: source.name, role: user.role, active: true };
    });
    res.status(201).json({ grant });
  });
  app.patch(`${prefix}/access/grants/:id`, requireAdmin, async (req, res) => {
    if (!identity) throw new AppError(409, 'La identidad externa no está configurada.', 'INTEGRATION_PENDING');
    const input = z.object({ role: z.enum(['admin', 'supervisor']).optional(), active: z.boolean().optional() }).strict().refine(value => value.role !== undefined || value.active !== undefined).parse(req.body);
    if (req.params.id === req.user.id && (input.active === false || input.role === 'supervisor')) throw new AppError(409, 'No puedes retirar tu propio acceso administrativo.', 'SELF_ACCESS');
    const grant = await store.transaction(state => {
      const user = state.users.find(item => item.id === req.params.id && item.externalGrant);
      if (!user) throw new AppError(404, 'Acceso no encontrado.', 'NOT_FOUND');
      Object.assign(user, input, { updatedBy: req.user.id, updatedAt: new Date().toISOString() });
      return { id: user.id, externalId: user.externalId, name: user.name, role: user.role, active: user.active };
    });
    res.json({ grant });
  });
  app.get(`${prefix}/bootstrap`, async (_req, res) => {
    const state = await readHistory();
    const dates = state.conversations.map(c => c.date).sort();
    res.json({
      mode: config.demo ? 'demo' : 'real', metadata: state.metadata, timezone: config.timezone,
      countries: (state.countries || countries).map(({ code, name }) => ({ code, name })),
      agents: [...new Map(state.conversations.map(c => [c.agent.id, { ...c.agent, country: c.country }])).values()],
      catalog: state.catalog.map(({ id, name, family, phase, mark, type, active, version }) => ({ id, name, family, phase, mark, type, active, version })),
      dateRange: { min: dates.at(0) || null, max: dates.at(-1) || null },
      integrations: integrationStatus(),
    });
  });
  app.get(`${prefix}/catalog`, async (req, res) => {
    const q = z.object({ q: z.string().max(300).optional(), family: z.string().max(120).optional(), type: z.enum(['Flag', 'Métrica', 'Descriptor', 'Calculado']).optional(), phase: z.coerce.number().int().min(1).max(3).optional(), active: z.enum(['true', 'false']).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25) }).parse(req.query);
    const state = await store.read();
    const normalized = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const filtered = state.catalog.filter(v => (!q.q || normalized(`${v.name} ${v.variable} ${v.definition}`).includes(normalized(q.q))) && (!q.family || v.family === q.family) && (!q.type || v.type === q.type) && (!q.phase || v.phase === q.phase) && (!q.active || v.active === (q.active === 'true'))).sort((a, b) => a.order - b.order);
    res.json({ items: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: filtered.length, totalCatalog: state.catalog.length, totalActive: state.catalog.filter(v => v.active).length, families: [...new Set(state.catalog.map(v => v.family))], page: q.page, pageSize: q.pageSize });
  });
  app.post(`${prefix}/catalog`, requireAdmin, async (req, res) => {
    const input = createCatalogSchema.parse(req.body);
    const item = await store.transaction(state => {
      if (state.catalog.some(v => v.variable === input.variable)) throw new AppError(409, 'Ya existe una variable con ese código.', 'DUPLICATE_VARIABLE');
      const item = { ...input, id: input.variable, order: Math.max(0, ...state.catalog.map(v => v.order)) + 1, version: 1, template: false };
      validateCatalog(item); state.catalog.push(item); saveCatalogVersion(state, item, req.user, 'crear'); return item;
    });
    res.status(201).json({ item });
  });
  app.post(`${prefix}/catalog/batch-status`, requireAdmin, async (req, res) => {
    const input = batchSchema.parse(req.body);
    if (new Set(input.items.map(v => v.id)).size !== input.items.length) throw new AppError(422, 'La selección contiene variables duplicadas.');
    const result = await store.transaction(state => {
      const selected = input.items.map(ref => {
        const item = state.catalog.find(v => v.id === ref.id);
        if (!item) throw new AppError(404, 'Una variable seleccionada ya no existe.');
        ensureVersion(item, ref.version); validateCatalog({ ...item, active: input.active }); return item;
      });
      let changed = 0;
      for (const item of selected) if (item.active !== input.active) {
        item.active = input.active; item.version++; changed++;
        saveCatalogVersion(state, item, req.user, input.active ? 'activar' : 'inactivar');
      }
      return { changed };
    });
    res.json(result);
  });
  app.get(`${prefix}/catalog/:id/history`, async (req, res) => {
    const state = await store.read();
    if (!state.catalog.some(v => v.id === req.params.id)) throw new AppError(404, 'Variable no encontrada.');
    res.json({ items: state.catalogVersions.filter(v => v.itemId === req.params.id).reverse() });
  });
  app.patch(`${prefix}/catalog/:id`, requireAdmin, async (req, res) => {
    const { expectedVersion, ...input } = updateCatalogSchema.parse(req.body);
    const item = await store.transaction(state => {
      const current = state.catalog.find(v => v.id === req.params.id);
      if (!current) throw new AppError(404, 'Variable no encontrada.');
      ensureVersion(current, expectedVersion);
      const updated = { ...current, ...input, version: current.version + 1 };
      validateCatalog(updated); Object.assign(current, updated);
      saveCatalogVersion(state, current, req.user, 'editar'); return current;
    });
    res.json({ item });
  });
  const expose = async (state, userId, conversations, profileId) => {
    const evaluations = conversations.map(c => {
      const e = selectedEvaluation(state, c, profileId);
      if (!e) return null;
      // Viewing a legacy prediction can bias a later review even when its original
      // input cannot be proven equivalent. Track exposure conservatively, without
      // promoting the legacy evaluation into the comparable cohort.
      return e.sourceHash ? e : { ...e, sourceHash: sourceFingerprint(c),
        catalogVersions: e.catalogVersions.map(v => ({ ...v, active: e.results.some(r => r.variableId === v.id) })) };
    }).filter(Boolean);
    if (evaluations.length) await store.transaction(s => evaluations.forEach(e => exposeEvaluation(s, userId, e)));
  };
  app.get(`${prefix}/summary`, async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    if (query.modelProfileId && req.user.role !== 'admin') throw new AppError(403, 'La consulta por modelo está disponible solo en administración.', 'FORBIDDEN');
    const state = await readHistory();
    const conversations = filteredConversations(state, query);
    await expose(state, req.user.id, state.conversations.filter(c => conversations.some(v => v.id === c.id)), query.modelProfileId);
    const priority = conversations.filter(c => c.p1 || c.p2).sort(priorityOrder);
    res.json({ metrics: summarize(conversations), conversations, priority: priority.slice(0, 3), priorityTotal: priority.length, metadata: state.metadata });
  });
  const list = (search = false) => async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    if (query.modelProfileId && req.user.role !== 'admin') throw new AppError(403, 'La consulta por modelo está disponible solo en administración.', 'FORBIDDEN');
    const state = await readHistory();
    const items = filteredConversations(state, query, search);
    await expose(state, req.user.id, state.conversations.filter(c => items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).some(v => v.id === c.id)), query.modelProfileId);
    res.json({ items: items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: items.length, page: query.page, pageSize: query.pageSize });
  };
  app.get(`${prefix}/conversations`, list());
  app.get(`${prefix}/search`, list(true));
  app.get(`${prefix}/conversations/:id`, async (req, res) => {
    const state = await readHistory();
    const conversation = state.conversations.find(c => c.id === req.params.id);
    if (!conversation) throw new AppError(404, 'No se encontró esta conversación.', 'NOT_FOUND');
    const query = listQuerySchema.parse(req.query);
    if (query.modelProfileId && req.user.role !== 'admin') throw new AppError(403, 'La consulta por modelo está disponible solo en administración.', 'FORBIDDEN');
    await expose(state, req.user.id, [conversation], query.modelProfileId);
    res.json({ conversation: conversationView(state, conversation, viewContext(state, query.modelProfileId), true) });
  });
  app.post(`${prefix}/conversations/:id/reviews`, async (req, res) => {
    const input = reviewSchema.parse(req.body);
    const review = await reviewHistory(state => recordReview(state, req.params.id, input, req.user));
    res.status(201).json({ review });
  });
  app.get(`${prefix}/evaluations`, requireAdmin, async (_req, res) => {
    await recoverEvaluationJobs(store);
    const state = await store.read();
    res.json({ status: status(), settings: state.settings, jobs: state.jobs, activeCount: state.catalog.filter(v => v.active).length, mode: config.demo ? 'demo' : 'real' });
  });
  app.patch(`${prefix}/evaluations/settings`, requireAdmin, async (req, res) => {
    const { expectedVersion, ...input } = settingsSchema.parse(req.body);
    if (input.dailyEnabled && (config.demo || !store.readWithConversations || !status().ready)) throw new AppError(409, 'La evaluación diaria requiere Atom, Pulso y un modelo habilitado en modo real.', 'INTEGRATION_PENDING', integrationStatus().blockers);
    const settings = await store.transaction(state => {
      ensureVersion(state.settings, expectedVersion);
      state.settings = { ...state.settings, ...input, dailyStartedAt: state.settings.dailyStartedAt || (input.dailyEnabled ? new Date().toISOString() : null), version: state.settings.version + 1, updatedBy: req.user.name, updatedAt: new Date().toISOString() };
      return state.settings;
    });
    res.json({ settings });
  });
  app.post(`${prefix}/evaluations`, requireAdmin, async (req, res) => {
    if (!registry.configured) throw new AppError(409, 'No hay un modelo configurado y habilitado.', 'EVALUATION_DISABLED');
    if (config.demo || !store.readWithConversations) throw new AppError(409, 'La evaluación requiere Atom y la base real de Pulso.', 'INTEGRATION_PENDING');
    const input = evaluationRequestSchema.parse(req.body);
    const { job, completion } = await startEvaluationBatch(store, registry, { pendingOnly: input.scope === 'new', from: input.from, to: input.to, max: input.max, idempotencyKey: input.idempotencyKey, author: req.user });
    completion.catch(error => console.error('Error en ejecución de Pulso:', error.code || error.name));
    res.status(202).json({ job });
  });
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada.' } }));
  app.use((error, _req, res, _next) => {
    if (error instanceof ZodError) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: error.issues.map(i => `${i.path.join('.') || 'Datos'}: ${i.message}`).join(' · ') } });
    if (error instanceof AppError) return res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'El contenido JSON no es válido.' } });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'La solicitud supera el tamaño permitido.' } });
    const databaseError = error.code && /^(ER_|ECONN|ENOTFOUND|ETIMEDOUT)/.test(error.code);
    console.error('Error Pulso:', error.code || error.name);
    res.status(databaseError ? 503 : 500).json({ error: { code: databaseError ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR', message: databaseError ? 'No se pudo acceder a una base de datos. Revisa las conexiones de Pulso y Atom.' : 'No se pudo completar la operación. No se ha confirmado ningún cambio.' } });
  });
  return app;
}
