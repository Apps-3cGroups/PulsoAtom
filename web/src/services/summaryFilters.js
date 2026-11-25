import { compactMarks } from './summaryMap.js';
import { evaluationStatus, hasChangedEvaluation, displayedMarks, classificationOf } from './flags.js';

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
export function hasModelCoverage(conversation) {
  return typeof conversation.bothModelsComplete === 'boolean';
}
export function bothModelsComplete(conversation) {
  // The API verifies the operational pair, identities and technical errors.
  // Status labels alone cannot establish that coverage in an older response.
  return conversation.bothModelsComplete === true && evaluationStatus(conversation) === 'evaluated';
}
export function filterSummaryConversations(conversations, visible, { includePending = false, bothComplete = false } = {}) {
  if (!visible.length) return [];
  const eligible = conversations.filter(c => (!bothComplete || bothModelsComplete(c))
    && (includePending || !['not_evaluated', 'review_pending'].includes(evaluationStatus(c))));
  if (figureKinds.every(kind => visible.includes(kind))) return eligible;
  return eligible.filter(c => compactMarks([c], { visible, classification: 'all' }).kinds.length > 0);
}
export function summaryMetrics(conversations) {
  const evaluated = conversations.filter(c => c.evaluated).length;
  // Count the original saved findings only when historical visibility was verified by the API.
  const currentResults = conversations.filter(c => c.evaluated && evaluationStatus(c) === 'evaluated' && !hasChangedEvaluation(c));
  const savedResults = conversations.filter(c => c.evaluated && evaluationStatus(c) === 'evaluated'
    && (!hasChangedEvaluation(c) || c.historicalFlagsAvailable === true));
  const savedAlertCases = savedResults.filter(c => displayedMarks(c).some(m => m.kind !== 'refuted'
    && (m.effective || m.historical) && ['critical', 'normal'].includes(classificationOf(m)))).length;
  const savedPositiveCases = savedResults.filter(c => displayedMarks(c).some(m => m.kind !== 'refuted'
    && (m.effective || m.historical) && classificationOf(m) === 'positive')).length;
  const recoveredFlags = conversations.reduce((n, c) => n + displayedMarks(c).filter(m => m.historical).length, 0);
  const sourceChanged = conversations.filter(hasChangedEvaluation).length;
  const withAlerts = currentResults.filter(c => c.p1 || c.p2).length;
  const originalAlerts = currentResults.reduce((n, c) => n + (c.originalAlerts || 0), 0);
  const refuted = currentResults.reduce((n, c) => n + (c.refuted || 0), 0);
  return { total: conversations.length, evaluated, pending: conversations.length - evaluated, withAlerts,
    currentResults: currentResults.length, sourceChanged, savedResults: savedResults.length, savedAlertCases, savedPositiveCases, recoveredFlags,
    alertPercent: currentResults.length ? Math.round(withAlerts / currentResults.length * 100) : null, originalAlerts, refuted,
    refutedPercent: originalAlerts ? Math.round(refuted / originalAlerts * 100) : null,
    withPositives: currentResults.filter(c => c.positive > 0).length,
    human: currentResults.reduce((n, c) => n + (c.human || 0), 0) };
}
