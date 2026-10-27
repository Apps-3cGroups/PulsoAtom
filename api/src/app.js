import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { z, ZodError } from 'zod';
import { AppError } from './errors.js';
import { tokenHash, newToken, verifyPassword, publicUser, requireUser, requireAdmin } from './auth.js';
import { countries } from './data/seed.js';
import { createCatalogSchema, updateCatalogSchema, batchSchema, validateCatalog, saveCatalogVersion, ensureVersion, listQuerySchema, filteredConversations, summarize, priorityOrder, conversationView, recordReview, reviewSchema } from './domain.js';

const prefix = '/pulso/api';
const cookieName = 'pulso_session';
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) }).strict();
const settingsSchema = z.object({ dailyEnabled: z.boolean(), dailyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('es', { timeZone: value }); return true; } catch { return false; } }, 'Zona horaria inválida'), expectedVersion: z.number().int().positive() }).strict();
export const integrationStatus = () => ({
  ready: false,
  atomConfigured: !!(process.env.ATOM_DB_HOST && process.env.ATOM_DB_NAME && process.env.ATOM_CONVERSATIONS_TABLE && process.env.ATOM_MESSAGES_TABLE && process.env.ATOM_COUNTRIES_TABLE),
  aiConfigured: !!(process.env.AI_BASE_URL && process.env.AI_MODEL),
  blockers: [...(process.env.ATOM_DB_HOST && process.env.ATOM_DB_NAME && process.env.ATOM_COUNTRIES_TABLE ? [] : ['Configurar la lectura histórica de Atom.']), 'Configurar y validar el servicio de IA con las variables seleccionadas.', 'Habilitar el procesador de evaluaciones y su programación diaria.'],
});

export function createApp(store, config) {
  const app = express();
  const readHistory = () => store.readWithConversations ? store.readWithConversations() : store.read();
  const reviewHistory = fn => store.transactionWithConversations ? store.transactionWithConversations(fn) : store.transaction(fn);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
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
    res.status(storageReady ? 200 : 503).json({ status: storageReady ? 'ok' : 'configuration_required', mode: config.demo ? 'demo' : 'real', storage: config.demo ? 'local_demo_file' : 'mysql', storageReady, evaluationReady: false });
  });
  app.get(`${prefix}/meta`, (_req, res) => res.json({ name: 'Pulso', mode: config.demo ? 'demo' : 'real', timezone: config.timezone, version: '0.1.0' }));
  app.use(prefix, async (req, _res, next) => {
    const token = req.cookies[cookieName];
    if (typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      const state = await store.read();
      const session = state.sessions.find(s => s.id === tokenHash(token) && Date.parse(s.expiresAt) > Date.now());
      const user = session && state.users.find(u => u.id === session.userId && u.active);
      if (user) { req.user = publicUser(user); req.sessionId = session.id; }
    }
    next();
  });
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: config.secureCookie, path: '/pulso', maxAge: config.sessionHours * 3600000 };
  async function signIn(req, res, user) {
    const token = newToken();
    await store.transaction(state => {
      state.sessions = state.sessions.filter(s => Date.parse(s.expiresAt) > Date.now() && s.id !== req.sessionId);
      state.sessions.push({ id: tokenHash(token), userId: user.id, expiresAt: new Date(Date.now() + cookieOptions.maxAge).toISOString() });
    });
    res.cookie(cookieName, token, cookieOptions).json({ user: publicUser(user), mode: config.demo ? 'demo' : 'real' });
  }
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'RATE_LIMIT', message: 'Demasiados intentos. Intenta de nuevo en unos minutos.' } } });
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
    const input = loginSchema.parse(req.body);
    const state = await store.read();
    const user = state.users.find(u => u.email.toLowerCase() === input.email.toLowerCase() && u.active);
    if (!verifyPassword(input.password, user?.passwordHash)) throw new AppError(401, 'Correo o contraseña incorrectos.', 'INVALID_CREDENTIALS');
    await signIn(req, res, user);
  });
  app.get(`${prefix}/auth/me`, requireUser, (req, res) => res.json({ user: req.user, mode: config.demo ? 'demo' : 'real' }));
  app.post(`${prefix}/auth/logout`, async (req, res) => {
    if (req.sessionId) await store.transaction(state => { state.sessions = state.sessions.filter(s => s.id !== req.sessionId); return null; });
    res.clearCookie(cookieName, { path: '/pulso', httpOnly: true, sameSite: 'strict', secure: config.secureCookie }).status(204).end();
  });
  app.use(prefix, requireUser);
  app.get(`${prefix}/bootstrap`, async (_req, res) => {
    const state = await readHistory();
    const dates = state.conversations.map(c => c.date).sort();
    res.json({
      mode: config.demo ? 'demo' : 'real', metadata: state.metadata, timezone: config.timezone,
      countries: (state.countries || countries).map(({ code, name }) => ({ code, name })),
      agents: [...new Map(state.conversations.map(c => [c.agent.id, { ...c.agent, country: c.country }])).values()],
      catalog: state.catalog.map(({ id, name, family, phase, mark, active, version }) => ({ id, name, family, phase, mark, active, version })),
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
  app.get(`${prefix}/summary`, async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const state = await readHistory();
    const conversations = filteredConversations(state, query);
    const priority = conversations.filter(c => c.p1 || c.p2).sort(priorityOrder);
    res.json({ metrics: summarize(conversations), conversations, priority: priority.slice(0, 3), priorityTotal: priority.length, metadata: state.metadata });
  });
  const list = (search = false) => async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const state = await readHistory();
    const items = filteredConversations(state, query, search);
    res.json({ items: items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: items.length, page: query.page, pageSize: query.pageSize });
  };
  app.get(`${prefix}/conversations`, list());
  app.get(`${prefix}/search`, list(true));
  app.get(`${prefix}/conversations/:id`, async (req, res) => {
    const state = await readHistory();
    const conversation = state.conversations.find(c => c.id === req.params.id);
    if (!conversation) throw new AppError(404, 'No se encontró esta conversación.', 'NOT_FOUND');
    res.json({ conversation: conversationView(state, conversation, undefined, true) });
  });
  app.post(`${prefix}/conversations/:id/reviews`, async (req, res) => {
    const input = reviewSchema.parse(req.body);
    const review = await reviewHistory(state => recordReview(state, req.params.id, input, req.user));
    res.status(201).json({ review });
  });
  app.get(`${prefix}/evaluations`, async (_req, res) => {
    const state = await store.read();
    res.json({ status: integrationStatus(), settings: state.settings, jobs: state.jobs, activeCount: state.catalog.filter(v => v.active).length, mode: config.demo ? 'demo' : 'real' });
  });
  app.patch(`${prefix}/evaluations/settings`, requireAdmin, async (req, res) => {
    const { expectedVersion, ...input } = settingsSchema.parse(req.body);
    if (input.dailyEnabled) throw new AppError(409, 'La programación no puede activarse hasta configurar la IA y el procesador de evaluaciones.', 'INTEGRATION_PENDING', integrationStatus().blockers);
    const settings = await store.transaction(state => {
      ensureVersion(state.settings, expectedVersion);
      state.settings = { ...input, version: state.settings.version + 1, updatedBy: req.user.name, updatedAt: new Date().toISOString() };
      return state.settings;
    });
    res.json({ settings });
  });
  app.post(`${prefix}/evaluations`, (_req, _res) => {
    throw new AppError(409, 'La evaluación real está pendiente de integración. No se ha creado ninguna ejecución.', 'INTEGRATION_PENDING', integrationStatus().blockers);
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
