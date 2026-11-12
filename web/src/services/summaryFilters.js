import { compactMarks } from './summaryMap.js';
import { evaluationStatus } from './flags.js';

export const figureKinds = ['critical', 'normal', 'positive', 'refuted', 'human'];
export function selectedCountries(params, countries) {
  const allowed = new Set(countries.map(c => c.code));
  return [...new Set((params.get('countries') ?? params.get('country') ?? '').split(',').filter(c => allowed.has(c)))].sort();
}
export function selectedFigures(params, kinds = figureKinds) {
  if (!params.has('figures')) return [...kinds];
  return [...new Set(params.get('figures').split(',').filter(k => kinds.includes(k)))];
}
export function cleanOverviewParams(params) {
  const next = new URLSearchParams(params);
  if (!next.has('countries') && next.has('country')) next.set('countries', next.get('country'));
  ['country', 'variable', 'pending', 'classification', 'agreement'].forEach(key => next.delete(key));
  return next;
}
export function filterSummaryConversations(conversations, visible) {
  if (!visible.length) return [];
  const eligible = conversations.filter(c => !['not_evaluated', 'review_pending'].includes(evaluationStatus(c)));
  if (figureKinds.every(kind => visible.includes(kind))) return eligible;
  return eligible.filter(c => compactMarks([c], { visible, classification: 'all' }).kinds.length > 0);
}
export function summaryMetrics(conversations) {
  const evaluated = conversations.filter(c => c.evaluated).length;
  const withAlerts = conversations.filter(c => c.p1 || c.p2).length;
  const originalAlerts = conversations.reduce((n, c) => n + (c.originalAlerts || 0), 0);
  const refuted = conversations.reduce((n, c) => n + (c.refuted || 0), 0);
  return { total: conversations.length, evaluated, pending: conversations.length - evaluated, withAlerts,
    alertPercent: evaluated ? Math.round(withAlerts / evaluated * 100) : null, originalAlerts, refuted,
    refutedPercent: originalAlerts ? Math.round(refuted / originalAlerts * 100) : null,
    withPositives: conversations.filter(c => c.positive > 0).length,
    human: conversations.reduce((n, c) => n + (c.human || 0), 0) };
}
