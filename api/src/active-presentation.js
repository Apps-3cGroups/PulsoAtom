import { z } from 'zod';

export const activeFigureKinds = ['critical', 'normal', 'positive'];
export const activeFiguresSchema = z.string().max(100)
  .refine(value => value === '' || value.split(',').every(kind => activeFigureKinds.includes(kind)), 'Selecciona únicamente Crítico, Menor o Positivo.')
  .optional()
  .transform(value => value === undefined ? [...activeFigureKinds] : [...new Set(value.split(',').filter(Boolean))]);

export function activeConversations(conversations, figures) {
  if (!figures.length) return [];
  const all = activeFigureKinds.every(kind => figures.includes(kind));
  return conversations.filter(c => !['not_evaluated', 'review_pending'].includes(c.evaluationStatus)
    && (all || c.marks.some(mark => mark.effective && mark.kind !== 'refuted' && figures.includes(mark.classification))));
}

// This order is local to Activas. Filtering never changes the saved counts.
export function activePriorityOrder(a, b) {
  return (b.p1 || 0) - (a.p1 || 0)
    || (b.p2 || 0) - (a.p2 || 0)
    || (b.positive || 0) - (a.positive || 0)
    || (b.displayAt || b.startedAt || '').localeCompare(a.displayAt || a.startedAt || '')
    || a.id.localeCompare(b.id);
}
