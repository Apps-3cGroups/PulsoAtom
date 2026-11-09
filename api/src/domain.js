import { messageCounts } from './message-counts.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import { selectedEvaluation, latestVerdict, sourceFingerprint, ensureEvaluationState } from './evaluation-context.js';
import { classificationOf, catalogAvailability, currentCatalog } from './catalog-presentation.js';
import { operationalConsensus } from './operational-evaluation.js';

export const catalogFields = z.object({
  name: z.string().trim().min(3).max(160), family: z.string().trim().min(3).max(120),
  type: z.enum(['Flag', 'Métrica', 'Descriptor', 'Calculado']),
  mark: z.enum(['', 'Crítico', 'P1', 'P2', '+', 'cat', 'sis', 't']),
  definition: z.string().trim().min(8).max(5000), method: z.enum(['IA', 'Código', 'IA + código', 'Cálculo']),
  phase: z.number().int().min(1).max(3), condition: z.string().trim().max(5000).default(''),
  polarity: z.enum(['negativo', 'positivo', 'contexto']).nullable(), active: z.boolean(),
}).strict();
export const createCatalogSchema = catalogFields.extend({ variable: z.string().trim().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/, 'Usa un código único en minúsculas separado por guiones bajos.').max(160) });
export const updateCatalogSchema = catalogFields.extend({ expectedVersion: z.number().int().positive() });
export const batchSchema = z.object({ items: z.array(z.object({ id: z.string().max(160), version: z.number().int().positive() })).min(1).max(500), active: z.boolean() }).strict();
export function validateCatalog(item) {
  if (item.retired && item.active) throw new AppError(422, 'Una variable retirada no se puede activar.', 'RETIRED_VARIABLE');
  if (item.template && item.active) throw new AppError(422, 'Las plantillas de guion no se pueden activar. Crea una variable con un punto concreto.', 'TEMPLATE_NOT_EVALUABLE');
  const availability = catalogAvailability(item);
  if (item.active && !availability.canActivate) throw new AppError(422, availability.reason, 'VARIABLE_NOT_READY');
  if (['Crítico', 'P1', 'P2'].includes(item.mark) && (!['Flag', 'Calculado'].includes(item.type) || item.polarity === 'positivo')) throw new AppError(422, 'La clasificación de alerta requiere un flag o calculado no positivo.', 'INVALID_PRIORITY');
  if (item.mark === '+' && !['Flag', 'Calculado'].includes(item.type)) throw new AppError(422, 'Solo un flag puede tener una marca positiva.', 'INVALID_POLARITY');
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
export function viewContext(state, profileId) {
  return {
    profileId,
    versions: new Map(state.catalogVersions.map(v => [v.id, v.snapshot])),
    evaluations: new Map(state.evaluations.map(e => [e.id, e])),
    reviews: Map.groupBy ? Map.groupBy(state.reviews, r => r.conversationId) : state.reviews.reduce((m, r) => m.set(r.conversationId, [...(m.get(r.conversationId) || []), r]), new Map()),
  };
}
// Completion describes the saved executions, not whether every business
// question has a conclusive answer. Valid abstentions remain completed work.
export function evaluationCompletion(evaluation, variables, profileView = false) {
  if (!evaluation) return 'not_evaluated';
  const reviews = evaluation.modelReviews || [];
  const technicalError = variables.some(v => v.enabledInEvaluation
    && (v.result.error || v.result.comparison?.cells?.some(cell => cell.error)));
  if (reviews.some(r => ['pending', 'running'].includes(r.status))) return 'review_pending';
  if (technicalError || reviews.some(r => ['partial', 'failed'].includes(r.status)) || (!reviews.length && evaluation.partial)) return 'partial';
  const requiresTwoModels = !profileView && variables.some(v => v.enabledInEvaluation && v.classification
    && ['IA', 'IA + código'].includes(v.method));
  if (requiresTwoModels && !evaluation.dual) return 'review_pending';
  return 'evaluated';
}
export function conversationView(state, conversation, context = viewContext(state), detail = false) {
  const evaluation = selectedEvaluation(state, conversation, context.profileId);
  const reviews = (context.profileId ? [] : context.reviews.get(conversation.id) || []).filter(r => r.evaluationId === evaluation?.id);
  const latest = new Map();
  for (const review of reviews) latest.set(review.variableId, review.action === 'deshacer' ? null : review);
  const resultMap = new Map((evaluation?.results || []).map(r => [r.variableId, r]));
  const scope = evaluation?.catalogVersions || currentCatalog(state).map(v => ({ id: v.id, version: v.version, active: v.active }));
  const variables = scope.map(ref => {
    const definition = context.versions.get(`${ref.id}:${ref.version}`);
    if (!definition) throw new AppError(500, 'Falta una versión del checklist referenciada por la evaluación.', 'MISSING_CATALOG_VERSION');
    const result = resultMap.get(ref.id) || { variableId: ref.id, status: 'no_evaluado', value: null, evidence: [] };
    const classification = classificationOf(definition);
    const consensus = operationalConsensus(evaluation, ref.id);
    const detected = result.status === 'evaluado' && result.value === 1 && !result.error;
    const automaticFlagVisible = !!classification && detected && (!!context.profileId || consensus?.detected === true);
    const consensusSuppressed = !context.profileId && !!classification && detected && !automaticFlagVisible;
    const sharedRule = ['Código', 'Cálculo'].includes(result.method || definition.method) || !!result.codeRule || !!result.comparison?.codeOnly || consensus?.agreement === 'rule';
    const consensusPending = !context.profileId && !!evaluation && !!classification && !!ref.active && !sharedRule && (consensus?.pending ?? !consensus);
    const verdict = latestVerdict(state, conversation.id, evaluation?.sourceHash, ref.id, ref.version);
    let review = context.profileId ? null : latest.get(ref.id);
    if (evaluation?.sourceHash && !context.profileId && verdict && (!review || verdict.createdAt >= review.createdAt)) {
      review = verdict && verdict.outcome !== 'reverted' && ((verdict.outcome === 'absent' && result.value === 1) || (verdict.outcome === 'present' && (!automaticFlagVisible || review?.action === 'levantar')))
        ? { ...verdict, action: verdict.outcome === 'absent' ? 'refutar' : 'levantar' } : null;
    }
    let kind = null;
    if (classification && review?.action === 'refutar') kind = 'refuted';
    else if (classification && review?.action === 'levantar') kind = 'human';
    else if (automaticFlagVisible) kind = classification;
    const priority = classification === 'critical' ? 'Crítico' : classification === 'normal' ? 'Normal' : null;
    const effective = !!kind && kind !== 'refuted';
    const dualDetected = effective && consensus?.detected === true;
    return { ...definition, availability: catalogAvailability(definition), enabledInEvaluation: ref.active, result, verdict, review: review || null, kind, classification, priority, origin: review?.action === 'levantar' ? 'human' : 'system', effective, dualDetected, automaticFlagVisible, consensusSuppressed, consensusPending };
  });
  const marks = variables.filter(v => v.kind).map(v => ({ id: v.id, name: v.name, kind: v.kind, priority: v.priority, classification: v.classification, origin: v.origin, effective: v.effective, dualDetected: v.dualDetected,
    comparison: v.result.comparison ? Object.fromEntries(['agreement', 'detections', 'votes', 'expected', 'missing', 'label'].map(k => [k, v.result.comparison[k]])) : null }));
  const p1 = marks.filter(m => m.effective && m.classification === 'critical').length;
  const p2 = marks.filter(m => m.effective && m.classification === 'normal').length;
  const positive = marks.filter(m => m.effective && m.classification === 'positive').length;
  // Retained historical refutations have a matching denominator even when their
  // original single-model alert is no longer published under the current policy.
  const originalAlerts = variables.filter(v => (v.automaticFlagVisible || v.kind === 'refuted') && ['critical', 'normal'].includes(v.classification)).length;
  const suppressedFlags = variables.filter(v => v.consensusSuppressed && !v.review).length;
  const consensusPendingFlags = variables.filter(v => v.consensusPending && !v.review).length;
  const pendingFlags = evaluation ? variables.filter(v => v.enabledInEvaluation && v.classification && v.result.status !== 'evaluado' && !v.review).length : 0;
  const evaluationErrors = variables.filter(v => v.enabledInEvaluation && (v.result.error || v.result.comparison?.cells?.some(cell => cell.error))).length;
  const evaluationStatus = evaluationCompletion(evaluation, variables, !!context.profileId);
  const unavailableFlags = variables.filter(v => evaluation && resultMap.has(v.id) && v.enabledInEvaluation && v.classification && !v.review
    && !v.result.error && !v.result.comparison?.cells?.some(cell => cell.error)
    && (v.result.status === 'no_evaluado' || v.result.comparison?.cells?.some(cell => cell.result?.status === 'no_evaluado'))).length;
  const base = { provisional: !!evaluation?.provisional, sourceChanged: !!evaluation?.sourceHash && evaluation.sourceHash !== sourceFingerprint(conversation), id: conversation.id, country: conversation.country, countryName: conversation.countryName, agent: conversation.agent, client: conversation.client, date: conversation.date, startedAt: conversation.startedAt, endedAt: conversation.endedAt, channel: conversation.channel, topics: conversation.topics, media: conversation.media, demo: conversation.demo, evaluated: !!evaluation, rawModelView: !!context.profileId,
    activityDate: conversation.activityDate || conversation.date, startedDate: conversation.startedDate,
    activityAt: conversation.activityAt, lastActivityAt: conversation.lastActivityAt || null,
    p1, p2, critical: p1, normal: p2, positive, dualDetected: marks.some(m => m.dualDetected), pendingFlags, suppressedFlags, consensusPendingFlags, evaluationErrors, evaluationStatus, unavailableFlags, evaluationIncomplete: ['partial', 'review_pending'].includes(evaluationStatus), marks, originalAlerts, refuted: marks.filter(m => m.kind === 'refuted' && m.classification !== 'positive').length, human: marks.filter(m => m.kind === 'human').length };
  return detail ? { ...base, messages: conversation.messages, messageCounts: messageCounts(conversation.messages), sourceUrl: conversation.sourceUrl, evaluation: evaluation ? { id: evaluation.id, dual: !!evaluation.dual, modelReviewPending: evaluationStatus === 'review_pending', modelReviews: evaluation.modelReviews || [], provisional: !!evaluation.provisional, createdAt: evaluation.createdAt, demo: evaluation.demo, profileId: evaluation.profileId, profileLabel: evaluation.profileLabel, model: evaluation.model, provider: evaluation.provider, requestedModel: evaluation.requestedModel, usedFallback: !!evaluation.usedFallback, sourceChanged: !!evaluation.sourceHash && evaluation.sourceHash !== sourceFingerprint(conversation), sourceHash: evaluation.sourceHash, evaluatedCount: evaluation.results.filter(r => r.status === 'evaluado').length } : null,
    metrics: variables.filter(v => v.type === 'Métrica'), descriptors: variables.filter(v => v.type === 'Descriptor'), variables, reviews } : base;
}
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Fecha inválida');
export const listQuerySchema = z.object({
  modelProfileId: z.string().max(160).optional(),
  from: dateOnly.optional(), to: dateOnly.optional(), country: z.string().max(10).optional(),
  dateBasis: z.enum(['started', 'activity']).default('activity'),
  agent: z.string().max(120).optional(), q: z.string().max(300).optional(), variable: z.string().max(160).optional(),
  priority: z.enum(['P1', 'P2', 'Crítico', 'Normal', 'all']).optional(),
  classification: z.enum(['critical', 'normal', 'positive', 'all']).optional(), agreement: z.enum(['both', 'all']).optional(),
  status: z.enum(['evaluated', 'pending', 'all']).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(15),
}).refine(q => !q.from || !q.to || q.from <= q.to, 'La fecha inicial no puede ser posterior a la final.');
const normalize = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const displayDateOf = (conversation, basis) => basis === 'started' ? conversation.startedDate || conversation.date : conversation.activityDate || conversation.date;
const displayTimeOf = (conversation, basis) => basis === 'started' ? conversation.startedAt : conversation.activityAt || conversation.lastActivityAt || conversation.startedAt;
export function filteredConversations(state, query, textSearch = false) {
  const context = viewContext(state, query.modelProfileId);
  return state.conversations.filter(c => (!query.from || displayDateOf(c, query.dateBasis) >= query.from) && (!query.to || displayDateOf(c, query.dateBasis) <= query.to) && (!query.country || c.country === query.country) && (!query.agent || c.agent.id === query.agent)).map(c => {
    const view = conversationView(state, c, context);
    view.displayDate = displayDateOf(c, query.dateBasis);
    view.displayAt = displayTimeOf(c, query.dateBasis);
    view.dateBasis = query.dateBasis || 'activity';
    if (query.q) {
      const needle = normalize(query.q);
      const haystack = normalize([view.id, view.client.name, view.client.code, view.client.phoneLast4, view.agent.name, ...view.topics, ...view.marks.map(m => m.name)].join(' '));
      const message = textSearch ? c.messages.find(m => normalize(m.text).includes(needle)) : null;
      if (!haystack.includes(needle) && !message) return null;
      view.excerpt = message ? { text: message.text, messageId: message.id, actor: message.actor } : null;
    }
    return view;
  }).filter(c => {
    if (!c) return false;
    const classification = query.classification && query.classification !== 'all' ? query.classification
      : ({ P1: 'critical', P2: 'normal', 'Crítico': 'critical', Normal: 'normal' })[query.priority];
    const hasMarkFilter = classification || query.variable || query.agreement === 'both';
    const matches = !hasMarkFilter || c.marks.some(m => (!classification || (m.effective && m.classification === classification))
      && (!query.variable || m.id === query.variable) && (query.agreement !== 'both' || m.dualDetected));
    return matches && (!query.status || query.status === 'all' || (query.status === 'evaluated' ? c.evaluated : !c.evaluated));
  }).sort((a, b) => (b.displayAt || b.displayDate).localeCompare(a.displayAt || a.displayDate) || a.id.localeCompare(b.id));
}
export function summarize(conversations) {
  const evaluated = conversations.filter(c => c.evaluated).length;
  const withAlerts = conversations.filter(c => c.p1 || c.p2).length;
  const originalAlerts = conversations.reduce((n, c) => n + c.originalAlerts, 0);
  const refuted = conversations.reduce((n, c) => n + c.refuted, 0);
  return { total: conversations.length, evaluated, pending: conversations.length - evaluated, withAlerts, alertPercent: evaluated ? Math.round(withAlerts / evaluated * 100) : null, originalAlerts, refuted, refutedPercent: originalAlerts ? Math.round(refuted / originalAlerts * 100) : null,
    withPositives: conversations.filter(c => c.positive > 0).length, positives: conversations.reduce((n, c) => n + c.positive, 0), withDualDetection: conversations.filter(c => c.dualDetected).length,
    human: conversations.reduce((n, c) => n + c.human, 0), multimedia: conversations.filter(c => c.media.length).length };
}
export function priorityOrder(a, b) {
  return Number(b.p1 > 0) - Number(a.p1 > 0) || b.p1 - a.p1 || b.p2 - a.p2 || (b.displayAt || b.startedAt).localeCompare(a.displayAt || a.startedAt) || a.id.localeCompare(b.id);
}
export const reviewSchema = z.object({
  variableId: z.string().max(160), evaluationId: z.string().max(180),
  expectedReviewId: z.string().nullable(), expectedVerdictId: z.string().nullable().optional(), action: z.enum(['refutar', 'levantar', 'deshacer']),
  reason: z.enum(['falso_positivo', 'evidencia_mal_interpretada', 'falta_contexto', 'omision_del_modelo', 'otro']),
  comment: z.string().trim().min(5).max(2000), messageId: z.string().max(200).optional(),
}).strict();
export function recordReview(state, conversationId, body, user) {
  const conversation = state.conversations.find(c => c.id === conversationId);
  if (!conversation) throw new AppError(404, 'No se encontró la conversación.');
  const evaluation = selectedEvaluation(state, conversation);
  if (evaluation?.id !== body.evaluationId) throw new AppError(409, 'La evaluación cambió. Recarga la conversación.', 'VERSION_CONFLICT');
  if (evaluation?.sourceHash && evaluation.sourceHash !== sourceFingerprint(conversation)) throw new AppError(409, 'La conversación cambió en Atom. Evalúa su contenido actual antes de revisar.', 'SOURCE_CHANGED');
  const view = conversationView(state, conversation, undefined, true);
  const variable = view.variables.find(v => v.id === body.variableId);
  if (!variable || !variable.enabledInEvaluation || !classificationOf(variable) || (variable.result.status !== 'evaluado' && !(body.action === 'deshacer' && variable.review))) throw new AppError(422, 'Esta variable no tiene un resultado revisable en esta evaluación.');
  const history = view.reviews.filter(r => r.variableId === body.variableId);
  const last = history.at(-1);
  if ((last?.id || null) !== body.expectedReviewId) throw new AppError(409, 'La revisión cambió. Recarga antes de registrar otra.', 'VERSION_CONFLICT');
  if (body.action === 'refutar' && (!variable.automaticFlagVisible || variable.review)) throw new AppError(422, 'Solo puedes refutar un flag vigente de la IA.');
  if (body.action === 'levantar' && (variable.automaticFlagVisible || variable.review || ![0, 1].includes(variable.result.value))) throw new AppError(422, 'Solo puedes levantar un evento que no tenga un flag automático vigente.');
  if (body.action === 'deshacer' && !variable.review) throw new AppError(422, 'No existe una revisión vigente para deshacer.');
  const message = conversation.messages.find(m => m.id === body.messageId);
  if (body.action === 'levantar' && !message) throw new AppError(422, 'Selecciona un mensaje de esta conversación como evidencia.');
  const review = { id: randomUUID(), conversationId, evaluationId: body.evaluationId, variableId: body.variableId, action: body.action, reason: body.reason, comment: body.comment, evidence: body.action === 'levantar' ? { messageId: message.id, quote: message.text } : null, authorId: user.id, authorName: user.name, createdAt: new Date().toISOString() };
  if (evaluation.sourceHash) {
    ensureEvaluationState(state);
    const previous = latestVerdict(state, conversationId, evaluation.sourceHash, variable.id, variable.version);
    if ((previous?.id || null) !== (body.expectedVerdictId || null)) throw new AppError(409, 'El dictamen común cambió. Recarga antes de guardar.', 'VERSION_CONFLICT');
    state.verdicts.push({ ...review, sourceHash: evaluation.sourceHash, catalogVersion: variable.version,
      outcome: body.action === 'refutar' ? 'absent' : body.action === 'levantar' ? 'present' : 'reverted', mode: 'assisted', comparisonId: null });
  }
  state.reviews.push(review); return review;
}
