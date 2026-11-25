// The server owns membership. URLs carry only the selection identifier, never IDs.
export function reviewSelectionId(params) {
  const value = params.get('reviewSelection');
  return value && value !== 'all' ? value : undefined;
}

export function summarySelectionParams(params, selection) {
  const next = new URLSearchParams(params);
  // Explicit filters and the "all" opt-out survive refresh and back navigation.
  if (!next.toString() && selection?.id) next.set('reviewSelection', selection.id);
  return next;
}

export function selectedReview(params, selection) {
  return selection?.id && reviewSelectionId(params) === selection.id ? selection : null;
}

export function reviewSelectionSourceNote(selection) {
  return selection?.timeCorrectionCount > 0
    ? `${selection.timeCorrectionCount} conversaciones se evaluaron antes de la corrección de horas; conservan sus resultados originales.`
    : 'La fuente puede haberse actualizado desde la evaluación guardada.';
}

export function withSummaryPeriod(params, days = 3) {
  const next = new URLSearchParams(params);
  ['from', 'to', 'days'].forEach(key => next.delete(key));
  next.set('reviewSelection', 'all');
  next.set('days', String(days));
  next.delete('meetingPeriod');
  return next;
}

export function withSummaryDateRange(params, from, to, { meetingPeriod } = {}) {
  const next = new URLSearchParams(params);
  ['days', 'meetingPeriod', 'page'].forEach(key => next.delete(key));
  next.set('reviewSelection', 'all');
  next.set('from', from);
  next.set('to', to);
  if (meetingPeriod) {
    ['country', 'countries', 'figures'].forEach(key => next.delete(key));
    next.set('meetingPeriod', meetingPeriod); next.set('completion', 'both');
  }
  return next;
}
