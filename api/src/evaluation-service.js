import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { evaluateCodeVariable, supportsCodeVariable } from './code-evaluator.js';

const supportsAiVariable = variable => variable.type === 'Flag' && ['IA', 'IA + código'].includes(variable.method);
const supportsVariable = variable => supportsAiVariable(variable) || supportsCodeVariable(variable);

export function eligibleConversations(state, { from, to, country, pendingOnly = true, sourceChangedAfter } = {}) {
  return state.conversations.filter(c => c.messages.length && c.completed !== false && (!from || c.date >= from) && (!to || c.date <= to)
    && (!country || c.country === country) && (!pendingOnly || !c.evaluationId) && (!sourceChangedAfter || (c.sourceCreatedAt >= sourceChangedAfter || c.sourceUpdatedAt >= sourceChangedAfter)));
}

export async function evaluateConversation(store, evaluator, conversation, catalog, { replace = false } = {}) {
  const variables = catalog.filter(v => v.active);
  if (!variables.length || variables.some(variable => !supportsVariable(variable))) throw new AppError(422, 'El checklist activo incluye variables que aún no admite este evaluador.', 'UNSUPPORTED_VARIABLE');
  const aiVariables = variables.filter(supportsAiVariable);
  const answer = aiVariables.length ? await evaluator.evaluate(conversation, aiVariables) : { results: [], model: null, responseId: null, usage: null };
  const evaluation = {
    id: randomUUID(), conversationId: conversation.id, createdAt: new Date().toISOString(), demo: false,
    model: answer.model, providerResponseId: answer.responseId, usage: answer.usage,
    catalogVersions: catalog.map(v => ({ id: v.id, version: v.version, active: v.active })),
    results: [...answer.results, ...variables.filter(supportsCodeVariable).map(variable => evaluateCodeVariable(conversation, variable))],
  };
  await store.transaction(state => {
    if (!replace && state.evaluations.some(e => e.conversationId === conversation.id)) throw new AppError(409, 'La conversación ya tiene una evaluación guardada.', 'ALREADY_EVALUATED');
    for (const ref of evaluation.catalogVersions) {
      const current = state.catalog.find(v => v.id === ref.id);
      if (!current || current.version !== ref.version || current.active !== ref.active) throw new AppError(409, 'El checklist cambió durante la evaluación. Vuelve a intentarlo.', 'CATALOG_CHANGED');
    }
    state.evaluations.push(evaluation);
  });
  return evaluation;
}

export async function startEvaluationBatch(store, evaluator, { from, to, country, pendingOnly = true, max = 100, random = false, conversationIds, sourceJobId, sourceChangedAfter, scheduleDate, onProgress } = {}) {
  if (!evaluator.configured) throw new AppError(503, 'Falta configurar OpenAI.', 'AI_NOT_CONFIGURED');
  const state = await store.readWithConversations();
  const catalog = state.catalog;
  const active = catalog.filter(v => v.active);
  if (!active.length || active.some(variable => !supportsVariable(variable))) throw new AppError(422, 'El checklist activo incluye variables que aún no admite este evaluador.', 'UNSUPPORTED_VARIABLE');
  let candidates = eligibleConversations(state, { from, to, country, pendingOnly, sourceChangedAfter });
  if (conversationIds) {
    if (!Array.isArray(conversationIds) || !conversationIds.length || new Set(conversationIds).size !== conversationIds.length) throw new AppError(422, 'La lista de conversaciones para revisión es inválida.', 'INVALID_RECHECK');
    const byId = new Map(candidates.map(c => [c.id, c]));
    candidates = conversationIds.map(id => byId.get(id));
    if (candidates.some(c => !c)) throw new AppError(422, 'Una conversación de la muestra ya no está disponible.', 'INVALID_RECHECK');
  }
  if (random) {
    candidates = [...candidates];
    for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
  }
  candidates = candidates.slice(0, max);
  const job = { id: randomUUID(), status: 'running', scope: scheduleDate ? 'daily' : conversationIds ? 'recheck' : pendingOnly ? 'pending' : 'period', sourceJobId: sourceJobId || null, scheduleDate: scheduleDate || null, from: from || null, to: to || null, country: country || null,
    total: candidates.length, completed: 0, failed: 0, errors: [], conversationIds: candidates.map(c => c.id),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: null };
  await store.transaction(draft => {
    if (scheduleDate) {
      if (!draft.settings.dailyEnabled || draft.settings.dailyStartedAt !== sourceChangedAfter) throw new AppError(409, 'La programación diaria cambió.', 'SCHEDULE_CHANGED');
      if (draft.jobs.some(j => j.scheduleDate === scheduleDate)) throw new AppError(409, 'La ejecución diaria ya se inició.', 'DAILY_ALREADY_STARTED');
    }
    const cutoff = Date.now() - 10 * 60_000;
    for (const previous of draft.jobs.filter(j => j.status === 'running')) {
      if (Date.parse(previous.updatedAt || previous.createdAt) < cutoff) {
        previous.status = 'interrupted'; previous.finishedAt = new Date().toISOString();
      }
    }
    if (draft.jobs.some(j => j.status === 'running')) throw new AppError(409, 'Ya hay una evaluación en curso.', 'EVALUATION_RUNNING');
    draft.jobs.push(job);
  });
  const completion = processEvaluationJob(store, evaluator, job, candidates, catalog, pendingOnly, onProgress);
  return { job, completion };
}

async function processEvaluationJob(store, evaluator, job, candidates, catalog, pendingOnly, onProgress) {
  for (const conversation of candidates) {
    let error = null;
    try { await evaluateConversation(store, evaluator, conversation, catalog, { replace: !pendingOnly }); }
    catch (caught) { error = caught; }
    await store.transaction(draft => {
      const current = draft.jobs.find(j => j.id === job.id);
      if (error) { current.failed++; current.errors.push({ conversationId: conversation.id, code: error instanceof AppError ? error.code : 'EVALUATION_FAILED', message: error instanceof AppError ? error.message : 'No se pudo completar esta evaluación.' }); }
      else current.completed++;
      current.updatedAt = new Date().toISOString();
    });
    if (onProgress) await onProgress({ conversationId: conversation.id, error: error?.message || null });
  }
  await store.transaction(draft => {
    const current = draft.jobs.find(j => j.id === job.id);
    current.status = current.failed ? (current.completed ? 'partial' : 'failed') : 'completed';
    current.finishedAt = new Date().toISOString();
    current.updatedAt = current.finishedAt;
  });
  return (await store.read()).jobs.find(j => j.id === job.id);
}

export async function runEvaluationBatch(store, evaluator, options) {
  const { completion } = await startEvaluationBatch(store, evaluator, options);
  return completion;
}
