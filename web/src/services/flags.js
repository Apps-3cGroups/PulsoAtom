export const classificationOf = item => {
  if (['critical', 'normal', 'positive'].includes(item.classification)) return item.classification;
  if (item.type && !['Flag', 'Calculado'].includes(item.type)) return null;
  if ((item.mark || item.priority) === '+' || item.kind === 'positive') return 'positive';
  if (['Crítico', 'P1', 'critical'].includes(item.mark || item.priority) || ['critical', 'p1'].includes(item.kind)) return 'critical';
  return 'normal';
};
export const flagLabel = kind => ({ critical: 'Flag crítico', normal: 'Flag menor', positive: 'Positivo', human: 'Flag humano', refuted: 'Refutado', P1: 'Flag crítico', P2: 'Flag menor', Crítico: 'Flag crítico', '+': 'Positivo' }[kind] || kind);
export const markKind = item => ['human', 'refuted'].includes(item.kind) ? item.kind : classificationOf(item);
export const isDualDetection = mark => {
  if (mark.effective === false || mark.kind === 'refuted' || mark.codeRule || mark.error) return false;
  if (typeof mark.dualDetected === 'boolean') return mark.dualDetected;
  return mark.comparison?.agreement === 'agree-positive' && mark.comparison?.detections === 2 && mark.comparison?.votes === 2 && !mark.comparison?.codeOnly;
};
export const dualMarks = (conversation, variable) => (conversation.marks || []).filter(m => (!variable || m.id === variable) && isDualDetection(m));
export const flagCount = (conversation, classification) => conversation[classification] ?? (classification === 'critical' ? conversation.p1 : classification === 'normal' ? conversation.p2 : undefined) ?? (conversation.marks || []).filter(m => m.effective && classificationOf(m) === classification).length;
export const flagVariables = catalog => catalog.filter(v => ['Flag', 'Calculado'].includes(v.type));
export const metricValue = variable => variable?.result?.status === 'evaluado' && typeof variable.result.value === 'number' && Number.isFinite(variable.result.value) ? variable.result.value : null;

export const evaluationStatus = conversation => conversation.evaluationStatus || (!conversation.evaluated ? 'not_evaluated'
  : conversation.evaluationErrors > 0 ? 'partial' : conversation.consensusPendingFlags > 0 ? 'review_pending'
    : conversation.evaluationIncomplete ? 'partial' : 'evaluated');
// Source freshness is separate from whether the saved executions finished.
export const hasChangedEvaluation = (conversation = {}) => !!(conversation.evaluated || conversation.evaluation)
  && !!(conversation.sourceChanged || conversation.evaluation?.sourceChanged);
export const needsModelReview = conversation => conversation.evaluationStatus ? conversation.evaluationStatus === 'review_pending' : (conversation.consensusPendingFlags || 0) > 0;
export const evaluationNeedsAttention = conversation => evaluationStatus(conversation) !== 'evaluated';
export const evaluationPending = conversation => conversation.evaluationStatus ? ['not_evaluated', 'review_pending'].includes(conversation.evaluationStatus) : evaluationNeedsAttention(conversation);
export const evaluationStatusLabel = conversation => {
  const status = evaluationStatus(conversation);
  const label = { not_evaluated: 'Sin evaluar', review_pending: 'Falta una revisión de modelo', partial: 'Evaluada con incidencias', evaluated: 'Evaluada' }[status];
  return hasChangedEvaluation(conversation) ? `Resultados históricos · datos actualizados${status === 'evaluated' ? '' : ` · ${label}`}` : label;
};
export function evaluationCoverage(conversations) {
  const counts = { not_evaluated: 0, review_pending: 0, partial: 0, evaluated: 0 };
  for (const conversation of conversations) counts[evaluationStatus(conversation)]++;
  return counts;
}
export const noVisibleFlagsLabel = conversation => hasChangedEvaluation(conversation) ? 'Flags automáticos pendientes de validar'
  : needsModelReview(conversation) ? 'Doble revisión pendiente'
  : conversation.suppressedFlags > 0 ? 'Sin flags con coincidencia' : 'Sin flags vigentes';

// Retained individual results are not equivalent to a published operational flag.
export function unmarkedResultLabel(variable) {
  if (variable.result.comparison?.sourceChanged) return variable.result.comparison.agreement === 'agree-positive'
    ? 'Coincidencia histórica · pendiente de validar' : 'Resultado histórico · pendiente de validar';
  if (variable.consensusSuppressed) {
    if (variable.result.codeRule || ['Código', 'Cálculo'].includes(variable.method)) return 'Calculado por código · fuera de los flags por coincidencia';
    if (variable.result.comparison?.agreement === 'disagree') return 'Los modelos discrepan · no se muestra como flag';
    return 'Detección sin doble coincidencia · no se muestra como flag';
  }
  if (variable.consensusPending) return 'Doble revisión pendiente · sin conclusión conjunta';
  return variable.result.value === 0 ? 'Evento no detectado' : String(variable.result.value ?? 'Sin resultado');
}

export const conversationMetricIds = ['min_primera_respuesta_humano', 'min_silencio_max_humano', 'min_duracion_conversacion', 'num_mensajes_asistente', 'num_mensajes_cliente', 'ratio_mensajes_asistente_entre_cliente', 'num_mensajes_por_turno_asistente'];

export const flagCountLabel = (kind, count) => count === undefined ? flagLabel(kind) : `${count} ${count === 1 ? ({ critical: 'flag crítico', normal: 'flag menor', positive: 'positivo' }[kind] || flagLabel(kind)) : ({ critical: 'flags críticos', normal: 'flags menores', positive: 'positivos' }[kind] || flagLabel(kind))}`;
