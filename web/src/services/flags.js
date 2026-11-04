export const classificationOf = item => {
  if (['critical', 'normal', 'positive'].includes(item.classification)) return item.classification;
  if (item.type && !['Flag', 'Calculado'].includes(item.type)) return null;
  if ((item.mark || item.priority) === '+' || item.kind === 'positive') return 'positive';
  if (['Crítico', 'P1', 'critical'].includes(item.mark || item.priority) || ['critical', 'p1'].includes(item.kind)) return 'critical';
  return 'normal';
};
export const flagLabel = kind => ({ critical: 'Flag crítico', normal: 'Flag normal', positive: 'Positivo', human: 'Flag humano', refuted: 'Refutado', P1: 'Flag crítico', P2: 'Flag normal', Crítico: 'Flag crítico', '+': 'Positivo' }[kind] || kind);
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

export const conversationMetricIds = ['min_primera_respuesta_humano', 'min_silencio_max_humano', 'min_duracion_conversacion', 'num_mensajes_asistente', 'num_mensajes_cliente', 'ratio_mensajes_asistente_entre_cliente', 'num_mensajes_por_turno_asistente'];

export const flagCountLabel = (kind, count) => count === undefined ? flagLabel(kind) : `${count} ${count === 1 ? ({ critical: 'flag crítico', normal: 'flag normal', positive: 'positivo' }[kind] || flagLabel(kind)) : ({ critical: 'flags críticos', normal: 'flags normales', positive: 'positivos' }[kind] || flagLabel(kind))}`;
