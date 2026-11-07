import { classificationOf } from './catalog-presentation.js';

const contextKeys = ['sourceHash', 'catalogHash', 'promptHash', 'rulesVersion'];
const detected = result => result?.status === 'evaluado' && result.value === 1 && !result.error;
const emptyTotals = () => ({ critical: 0, normal: 0, positive: 0, total: 0 });
const safeModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(value) ? value : 'Modelo no identificado';
const safeName = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160) : '';
const safeId = value => /^[A-Za-z0-9_-]{1,200}$/.test(String(value ?? '')) ? String(value) : null;

function accumulator() {
  const detections = emptyTotals(), conversations = new Set(), attention = new Set(), positives = new Set(), variables = new Map();
  return {
    add(conversationId, variable, classification) {
      detections[classification]++; detections.total++; conversations.add(conversationId);
      (classification === 'positive' ? positives : attention).add(conversationId);
      const key = `${variable.id}:${variable.version}:${classification}`;
      if (!variables.has(key)) variables.set(key, { id: variable.id, version: variable.version, name: safeName(variable.name), classification, count: 0, conversationIds: [] });
      const row = variables.get(key); row.count++;
      if (row.conversationIds.length < 3 && safeId(conversationId)) row.conversationIds.push(safeId(conversationId));
    },
    result() {
      return { conversationsWithAnyGemmaFlag: conversations.size, conversationsWithAttentionFlag: attention.size,
        conversationsWithPositiveFlag: positives.size, detections,
        topVariables: [...variables.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)).slice(0, 10) };
    },
  };
}

// Read-only diagnostic projection. Only the current operational reference counts;
// earlier attempts, code rules, metrics and descriptors cannot become Gemma flags.
export function gemmaDetectionSummary(state) {
  const maintenanceId = state.settings?.evaluationMaintenance;
  const original = accumulator(), effective = accumulator(), code = accumulator();
  const excluded = { references: 0, ambiguousReferences: 0, duplicateReferenceRows: 0, variables: 0 };
  const validScope = typeof maintenanceId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(maintenanceId);
  let currentConversations = 0, complete = 0, partial = 0, suppressedBySharedRule = 0;
  const models = new Set();
  const finish = () => {
    const originalGemmaDetections = original.result(), effectiveGemmaDetections = effective.result();
    const shared = code.result();
    return { available: validScope, scopeMaintenanceId: validScope ? maintenanceId : null,
      ...(validScope ? {} : { reason: 'MAINTENANCE_SCOPE_REQUIRED' }), currentConversations, complete, partial,
      models: [...models].sort(), ...effectiveGemmaDetections, originalGemmaDetections, effectiveGemmaDetections,
      sharedCode: { conversationsWithAnyCodeFlag: shared.conversationsWithAnyGemmaFlag, detections: shared.detections, topVariables: shared.topVariables },
      suppressedBySharedRule, excluded };
  };
  if (!validScope) return finish();
  const evaluations = new Map((state.evaluations || []).map(row => [row.id, row]));
  const tasks = new Map((state.tasks || []).map(row => [row.id, row]));
  const jobs = new Map((state.jobs || []).map(row => [row.id, row]));
  const versions = new Map((state.catalogVersions || []).map(row => [row.id || `${row.itemId}:${row.version}`, row.snapshot]));
  const references = new Map();
  for (const ref of state.operationalRefs || []) {
    if (!references.has(ref.id)) references.set(ref.id, []);
    references.get(ref.id).push(ref);
  }
  for (const refs of references.values()) {
    if (new Set(refs.map(ref => ref.evaluationId)).size !== 1) { excluded.ambiguousReferences++; continue; }
    excluded.duplicateReferenceRows += refs.length - 1;
    const ref = refs[0], evaluation = evaluations.get(ref.evaluationId), task = tasks.get(evaluation?.taskId), job = jobs.get(evaluation?.jobId);
    if (!evaluation || evaluation.profileId !== 'gemma-local' || evaluation.provider !== 'gateway'
      || evaluation.usedFallback || evaluation.purpose !== 'operational' || evaluation.conversationId !== ref.id
      || !task || task.evaluationId !== evaluation.id || task.jobId !== job?.id || task.conversationId !== ref.id
      || task.profile?.id !== 'gemma-local' || task.profile.provider !== 'gateway' || task.profile.model !== evaluation.model
      || !task.profile.configurationHash || task.profile.configurationHash !== evaluation.modelConfiguration?.configurationHash
      || job?.maintenanceId !== maintenanceId || job.purpose !== 'operational'
      || !contextKeys.every(key => evaluation[key] && evaluation[key] === task.context?.[key])) { excluded.references++; continue; }
    currentConversations++; models.add(safeModel(evaluation.model));
    if (evaluation.partial === false && task.status === 'completed') complete++; else partial++;
    const catalog = new Map((evaluation.catalogVersions || []).map(item => [item.id, item]));
    const counts = new Map();
    for (const result of evaluation.results || []) counts.set(result.variableId, (counts.get(result.variableId) || 0) + 1);
    for (const result of evaluation.results || []) {
      const item = catalog.get(result.variableId), definition = item && versions.get(`${item.id}:${item.version}`);
      if (counts.get(result.variableId) !== 1 || !item?.active || !definition || definition.id !== item.id || definition.version !== item.version) { excluded.variables++; continue; }
      const classification = classificationOf(definition);
      if (!classification) continue;
      const hasOriginal = result.aiResult && typeof result.aiResult === 'object' && !Array.isArray(result.aiResult);
      const method = result.method || definition.method;
      const sharedOnly = !hasOriginal && (['Código', 'Cálculo'].includes(method) || result.codeRule || result.comparison?.codeOnly);
      if (sharedOnly) { if (detected(result)) code.add(ref.id, definition, classification); continue; }
      if (!['IA', 'IA + código'].includes(method)) continue;
      const rawDetected = detected(hasOriginal ? result.aiResult : result), finalDetected = detected(result);
      if (rawDetected) original.add(ref.id, definition, classification);
      if (rawDetected && finalDetected) effective.add(ref.id, definition, classification);
      if (hasOriginal && rawDetected && !finalDetected && result.codeRule) suppressedBySharedRule++;
      if (hasOriginal && !rawDetected && finalDetected && result.codeRule) code.add(ref.id, definition, classification);
    }
  }
  return finish();
}
