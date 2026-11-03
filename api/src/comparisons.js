import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { latestVerdict, sourceFingerprint, wasExposed, ensureEvaluationState } from './evaluation-context.js';

export function findComparison(state, id) {
  const sample = (state.comparisons || []).find(c => c.id === id);
  if (!sample) throw new AppError(404, 'Muestra no encontrada.', 'NOT_FOUND');
  return sample;
}
export function sampleVariables(state, sample) {
  return sample.catalogVersions.filter(r => r.active).map(ref => {
    const v = state.catalogVersions.find(v => v.itemId === ref.id && v.version === ref.version)?.snapshot;
    if (!v) throw new AppError(409, 'Falta una versión del checklist.', 'MISSING_CATALOG_VERSION');
    return v;
  });
}
const isFlag = v => v.type === 'Flag' && v.method !== 'Código';
export function sampleSummary(state, sample, userId) {
  const job = state.jobs.find(j => j.id === sample.jobId);
  return { id: sample.id, name: sample.name, createdAt: sample.createdAt, demo: sample.demo,
    models: sample.modelProfiles, caseCount: sample.cases.length, status: job?.status, completed: job?.completed || 0, total: job?.total || 0,
    validated: sample.cases.filter(c => state.validations?.some(v => v.comparisonId === sample.id && v.conversationId === c.conversationId && v.authorId === userId)).length };
}
export function comparisonRows(state, sample) {
  const variables = sampleVariables(state, sample).filter(isFlag);
  return sample.cases.flatMap(c => variables.map(variable => {
    const cells = sample.modelProfiles.map(profile => {
      const task = state.tasks.find(t => t.jobId === sample.jobId && t.conversationId === c.conversationId && t.profile.id === profile.id);
      const evaluation = state.evaluations.find(e => e.id === task?.evaluationId);
      const result = evaluation?.results.find(r => r.variableId === variable.id);
      // A duplicate effective model never becomes an independent vote.
      return { profileId: profile.id, status: task?.status || 'pending', error: task?.error || null, model: evaluation?.model,
        provider: evaluation?.provider, result: result || null, evaluationId: evaluation?.id || null, durationMs: evaluation?.durationMs, usage: evaluation?.usage };
    });
    const seen = new Set();
    const votes = cells.filter(cell => {
      if (!cell.result || cell.result.codeRule || cell.result.method === 'Código' || cell.result.status !== 'evaluado') return false;
      const key = `${cell.provider}:${cell.model}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    const detections = votes.filter(cell => cell.result.value === 1).length;
    const complete = votes.length === sample.modelProfiles.length;
    const agreement = !complete ? 'incomplete' : detections && detections < votes.length ? 'disagreement' : 'agreement';
    const positiveEvidence = cells.filter(cell => cell.result?.value === 1).map(cell => cell.result.evidence.map(e => e.messageId));
    const sameEvidence = positiveEvidence.length > 1 && positiveEvidence[0].some(id => positiveEvidence.every(ids => ids.includes(id)));
    const source = state.conversations.find(x => x.id === c.conversationId);
    const verdict = latestVerdict(state, c.conversationId, c.sourceHash, variable.id, variable.version);
    return { id: `${c.conversationId}:${variable.id}`, conversationId: c.conversationId, clientName: source?.client.name || c.conversationId,
      country: c.country, variable: { id: variable.id, name: variable.name, version: variable.version, priority: variable.mark, method: variable.method },
      cells, detections, votes: votes.length, expected: sample.modelProfiles.length, agreement, sameEvidence,
      evidenceCompared: positiveEvidence.length > 1, sourceChanged: !source || sourceFingerprint(source) !== c.sourceHash, verdict };
  }));
}
export function qualityMetrics(rows, profiles) {
  // Comparable cohort: same cases, decisive blind reference, all models decisive.
  const reference = rows.filter(row => !row.sourceChanged && row.verdict?.mode === 'blind' && ['present', 'absent'].includes(row.verdict.outcome));
  const cohort = reference.filter(row => row.cells.every(c => c.status === 'completed' && c.result?.status === 'evaluado'));
  return profiles.map(profile => {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const row of cohort) {
      const predicted = row.cells.find(c => c.profileId === profile.id).result.value === 1, actual = row.verdict.outcome === 'present';
      if (predicted && actual) tp++; else if (predicted) fp++; else if (actual) fn++; else tn++;
    }
    const cells = rows.map(row => row.cells.find(c => c.profileId === profile.id));
    return { profileId: profile.id, tp, fp, fn, tn, n: cohort.length, referenceCount: reference.length,
      precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null,
      answered: cells.filter(c => c.result?.status === 'evaluado').length, abstained: cells.filter(c => c.result?.status === 'no_evaluado').length,
      missing: cells.filter(c => !c.result).length, total: cells.length };
  });
}
export function validationView(state, sample, conversationId, user) {
  const item = sample.cases.find(c => c.conversationId === conversationId);
  const conversation = state.conversations.find(c => c.id === conversationId);
  if (!item || !conversation) throw new AppError(404, 'Conversación no disponible.', 'NOT_FOUND');
  if (sourceFingerprint(conversation) !== item.sourceHash) throw new AppError(409, 'Atom cambió desde la muestra. Crea una muestra nueva para validar.', 'SOURCE_CHANGED');
  const variables = sampleVariables(state, sample).filter(isFlag);
  const session = state.validations?.find(v => v.comparisonId === sample.id && v.conversationId === conversationId && v.authorId === user.id);
  const assisted = !!session || variables.some(v => wasExposed(state, user.id, conversationId, item.sourceHash, v.id, v.version));
  // Deliberately construct a whitelist: no model results, flags, previous verdicts or evidence.
  return { conversation: { id: conversation.id, clientName: conversation.client.name, agentName: conversation.agent.name, country: conversation.country, messages: conversation.messages.map(m => ({ id: m.id, actor: m.actor, text: m.text, timestamp: m.timestamp })) },
    variables: variables.map(v => ({ id: v.id, name: v.name, definition: v.definition, condition: v.condition, version: v.version })),
    mode: assisted ? 'assisted' : 'blind', submitted: !!session, expectedVerdicts: Object.fromEntries(variables.map(v => [v.id, latestVerdict(state, conversationId, item.sourceHash, v.id, v.version)?.id || null])) };
}
export function saveValidation(state, sample, conversationId, input, user) {
  ensureEvaluationState(state);
  const view = validationView(state, sample, conversationId, user);
  const item = sample.cases.find(c => c.conversationId === conversationId);
  if (input.items.length !== view.variables.length || new Set(input.items.map(i => i.variableId)).size !== input.items.length) throw new AppError(422, 'Completa todas las variables una sola vez.', 'INCOMPLETE_VALIDATION');
  const createdAt = new Date().toISOString();
  for (const answer of input.items) {
    const variable = view.variables.find(v => v.id === answer.variableId);
    if (!variable) throw new AppError(422, 'Variable ajena al checklist.', 'INVALID_VARIABLE');
    if (answer.expectedVerdictId !== view.expectedVerdicts[variable.id]) throw new AppError(409, 'Otro supervisor guardó un dictamen. Recarga antes de continuar.', 'VERSION_CONFLICT');
    const message = view.conversation.messages.find(m => m.id === answer.messageId);
    if (answer.outcome === 'present' && !message) throw new AppError(422, 'Selecciona evidencia para los eventos presentes.', 'MISSING_EVIDENCE');
    state.verdicts.push({ id: randomUUID(), conversationId, comparisonId: sample.id, sourceHash: item.sourceHash,
      variableId: variable.id, catalogVersion: variable.version, outcome: answer.outcome, mode: view.mode,
      comment: answer.comment, reason: 'validacion_humana', evidence: answer.outcome === 'present' ? { messageId: message.id, quote: message.text } : null,
      authorId: user.id, authorName: user.name, createdAt });
  }
  const session = { id: randomUUID(), comparisonId: sample.id, conversationId, authorId: user.id, createdAt, mode: view.mode };
  state.validations.push(session);
  return session;
}
