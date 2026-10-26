import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';

export const catalogFields = z.object({
  name: z.string().trim().min(3).max(160), family: z.string().trim().min(3).max(120),
  type: z.enum(['Flag', 'Métrica', 'Descriptor', 'Calculado']),
  mark: z.enum(['', 'P1', 'P2', '+', 'cat', 'sis', 't']),
  definition: z.string().trim().min(8).max(5000), method: z.enum(['IA', 'Código', 'IA + código', 'Cálculo']),
  phase: z.number().int().min(1).max(3), condition: z.string().trim().max(5000).default(''),
  polarity: z.enum(['negativo', 'positivo', 'contexto']).nullable(), active: z.boolean(),
}).strict();
export const createCatalogSchema = catalogFields.extend({ variable: z.string().trim().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/, 'Usa un código único en minúsculas separado por guiones bajos.').max(160) });
export const updateCatalogSchema = catalogFields.extend({ expectedVersion: z.number().int().positive() });
export const batchSchema = z.object({ items: z.array(z.object({ id: z.string().max(160), version: z.number().int().positive() })).min(1).max(500), active: z.boolean() }).strict();
export function validateCatalog(item) {
  if (item.template && item.active) throw new AppError(422, 'Las plantillas de guion no se pueden activar. Crea una variable con un punto concreto.', 'TEMPLATE_NOT_EVALUABLE');
  if (['P1', 'P2'].includes(item.mark) && (!['Flag', 'Calculado'].includes(item.type) || item.polarity !== 'negativo')) throw new AppError(422, 'P1 y P2 requieren un flag o calculado con polaridad negativa.', 'INVALID_PRIORITY');
  if (item.mark === '+' && item.polarity !== 'positivo') throw new AppError(422, 'La marca positiva requiere polaridad positiva.', 'INVALID_POLARITY');
}
export function saveCatalogVersion(state, item, actor, action) {
  const createdAt = new Date().toISOString();
  state.catalogVersions.push({ id: `${item.id}:${item.version}`, itemId: item.id, version: item.version, snapshot: structuredClone(item), actor: actor.name, createdAt });
  state.catalogAudit.push({ id: randomUUID(), itemId: item.id, version: item.version, action, authorId: actor.id, authorName: actor.name, createdAt });
}
export function ensureVersion(item, expected) {
  if (item.version !== expected) throw new AppError(409, 'Otra persona modificó este registro. Recarga la información antes de guardar.', 'VERSION_CONFLICT');
}
export function viewContext(state) {
  return {
    versions: new Map(state.catalogVersions.map(v => [v.id, v.snapshot])),
    evaluations: new Map(state.evaluations.map(e => [e.id, e])),
    reviews: Map.groupBy ? Map.groupBy(state.reviews, r => r.conversationId) : state.reviews.reduce((m, r) => m.set(r.conversationId, [...(m.get(r.conversationId) || []), r]), new Map()),
  };
}
export function conversationView(state, conversation, context = viewContext(state), detail = false) {
  const evaluation = context.evaluations.get(conversation.evaluationId);
  const reviews = (context.reviews.get(conversation.id) || []).filter(r => r.evaluationId === evaluation?.id);
  const latest = new Map();
  for (const review of reviews) latest.set(review.variableId, review.action === 'deshacer' ? null : review);
  const resultMap = new Map((evaluation?.results || []).map(r => [r.variableId, r]));
  const scope = evaluation?.catalogVersions || state.catalog.map(v => ({ id: v.id, version: v.version, active: v.active }));
  const variables = scope.map(ref => {
    const definition = context.versions.get(`${ref.id}:${ref.version}`);
    if (!definition) throw new AppError(500, 'Falta una versión del checklist referenciada por la evaluación.', 'MISSING_CATALOG_VERSION');
    const result = resultMap.get(ref.id) || { variableId: ref.id, status: 'no_evaluado', value: null, evidence: [] };
    const review = latest.get(ref.id);
    let kind = null;
    if (review?.action === 'refutar') kind = 'refuted';
    else if (review?.action === 'levantar') kind = 'human';
    else if (result.status === 'evaluado' && result.value === 1 && definition.polarity === 'negativo') kind = definition.mark === 'P1' ? 'p1' : definition.mark === 'P2' ? 'p2' : 'coaching';
    const priority = ['P1', 'P2'].includes(definition.mark) ? definition.mark : null;
    const effective = kind && kind !== 'refuted';
    return { ...definition, enabledInEvaluation: ref.active, result, review: review || null, kind, priority, effective: !!effective };
  });
  const marks = variables.filter(v => v.kind).map(v => ({ id: v.id, name: v.name, kind: v.kind, priority: v.priority, effective: v.effective }));
  const p1 = marks.filter(m => m.effective && m.priority === 'P1').length;
  const p2 = marks.filter(m => m.effective && m.priority === 'P2').length;
  const originalAlerts = variables.filter(v => v.result.value === 1 && v.priority && v.polarity === 'negativo').length;
  const base = { id: conversation.id, country: conversation.country, countryName: conversation.countryName, agent: conversation.agent, client: conversation.client, date: conversation.date, startedAt: conversation.startedAt, endedAt: conversation.endedAt, channel: conversation.channel, topics: conversation.topics, media: conversation.media, demo: conversation.demo, evaluated: !!evaluation, p1, p2, marks, originalAlerts, refuted: marks.filter(m => m.kind === 'refuted' && m.priority).length, human: marks.filter(m => m.kind === 'human').length };
  return detail ? { ...base, messages: conversation.messages, sourceUrl: conversation.sourceUrl, evaluation: evaluation ? { id: evaluation.id, createdAt: evaluation.createdAt, demo: evaluation.demo, evaluatedCount: evaluation.results.filter(r => r.status === 'evaluado').length } : null, variables, reviews } : base;
}
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Fecha inválida');
export const listQuerySchema = z.object({
  from: dateOnly.optional(), to: dateOnly.optional(), country: z.string().max(10).optional(),
  agent: z.string().max(120).optional(), q: z.string().max(300).optional(), variable: z.string().max(160).optional(),
  priority: z.enum(['P1', 'P2', 'all']).optional(), status: z.enum(['evaluated', 'pending', 'all']).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(15),
}).refine(q => !q.from || !q.to || q.from <= q.to, 'La fecha inicial no puede ser posterior a la final.');
const normalize = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function filteredConversations(state, query, textSearch = false) {
  const context = viewContext(state);
  return state.conversations.filter(c => (!query.from || c.date >= query.from) && (!query.to || c.date <= query.to) && (!query.country || c.country === query.country) && (!query.agent || c.agent.id === query.agent)).map(c => {
    const view = conversationView(state, c, context);
    if (query.q) {
      const needle = normalize(query.q);
      const haystack = normalize([view.id, view.client.name, view.client.code, view.client.phoneLast4, view.agent.name, ...view.topics, ...view.marks.map(m => m.name)].join(' '));
      const message = textSearch ? c.messages.find(m => normalize(m.text).includes(needle)) : null;
      if (!haystack.includes(needle) && !message) return null;
      view.excerpt = message ? { text: message.text, messageId: message.id, actor: message.actor } : null;
    }
    return view;
  }).filter(c => c && (!query.priority || query.priority === 'all' || c[query.priority.toLowerCase()] > 0) && (!query.variable || c.marks.some(m => m.id === query.variable)) && (!query.status || query.status === 'all' || (query.status === 'evaluated' ? c.evaluated : !c.evaluated))).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
}
export function summarize(conversations) {
  const evaluated = conversations.filter(c => c.evaluated).length;
  const withAlerts = conversations.filter(c => c.p1 || c.p2).length;
  const originalAlerts = conversations.reduce((n, c) => n + c.originalAlerts, 0);
  const refuted = conversations.reduce((n, c) => n + c.refuted, 0);
  return { total: conversations.length, evaluated, pending: conversations.length - evaluated, withAlerts, alertPercent: evaluated ? Math.round(withAlerts / evaluated * 100) : null, originalAlerts, refuted, refutedPercent: originalAlerts ? Math.round(refuted / originalAlerts * 100) : null, human: conversations.reduce((n, c) => n + c.human, 0), multimedia: conversations.filter(c => c.media.length).length };
}
export function priorityOrder(a, b) {
  return Number(b.p1 > 0) - Number(a.p1 > 0) || b.p1 - a.p1 || b.p2 - a.p2 || b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id);
}
export const reviewSchema = z.object({
  variableId: z.string().max(160), evaluationId: z.string().max(180),
  expectedReviewId: z.string().nullable(), action: z.enum(['refutar', 'levantar', 'deshacer']),
  reason: z.enum(['falso_positivo', 'evidencia_mal_interpretada', 'falta_contexto', 'omision_del_modelo', 'otro']),
  comment: z.string().trim().min(5).max(2000), messageId: z.string().max(200).optional(),
}).strict();
export function recordReview(state, conversationId, body, user) {
  const conversation = state.conversations.find(c => c.id === conversationId);
  if (!conversation) throw new AppError(404, 'No se encontró la conversación.');
  if (conversation.evaluationId !== body.evaluationId) throw new AppError(409, 'La evaluación cambió. Recarga la conversación.', 'VERSION_CONFLICT');
  const view = conversationView(state, conversation, undefined, true);
  const variable = view.variables.find(v => v.id === body.variableId);
  if (!variable || !variable.enabledInEvaluation || !['Flag', 'Calculado'].includes(variable.type) || variable.polarity !== 'negativo' || variable.result.status !== 'evaluado') throw new AppError(422, 'Esta variable no tiene un resultado revisable en esta evaluación.');
  const history = view.reviews.filter(r => r.variableId === body.variableId);
  const last = history.at(-1);
  if ((last?.id || null) !== body.expectedReviewId) throw new AppError(409, 'La revisión cambió. Recarga antes de registrar otra.', 'VERSION_CONFLICT');
  if (body.action === 'refutar' && (variable.result.value !== 1 || variable.review)) throw new AppError(422, 'Solo puedes refutar un flag vigente del sistema.');
  if (body.action === 'levantar' && (variable.result.value !== 0 || variable.review)) throw new AppError(422, 'Solo puedes levantar un evento que el sistema no marcó.');
  if (body.action === 'deshacer' && !variable.review) throw new AppError(422, 'No existe una revisión vigente para deshacer.');
  const message = conversation.messages.find(m => m.id === body.messageId);
  if (body.action === 'levantar' && !message) throw new AppError(422, 'Selecciona un mensaje de esta conversación como evidencia.');
  const review = { id: randomUUID(), conversationId, evaluationId: body.evaluationId, variableId: body.variableId, action: body.action, reason: body.reason, comment: body.comment, evidence: body.action === 'levantar' ? { messageId: message.id, quote: message.text } : null, authorId: user.id, authorName: user.name, createdAt: new Date().toISOString() };
  state.reviews.push(review); return review;
}
