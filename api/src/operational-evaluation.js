// Derive one operational result without modifying either provider's stored answer.
const equivalent = (a, b) => ['sourceHash', 'catalogHash', 'promptHash', 'rulesVersion'].every(key => a[key] && a[key] === b[key]);
const conclusive = r => r?.status === 'evaluado' && [0, 1].includes(r.value);

export function operationalEvaluation(state, anchor) {
  if (!anchor) return anchor;
  const job = state.jobs.find(j => j.id === anchor.jobId);
  if (job?.mode !== 'dual' || job.purpose !== 'operational') return anchor;
  const tasks = state.tasks.filter(t => t.jobId === job.id && t.conversationId === anchor.conversationId);
  const evaluations = job.modelProfiles.map(profile => {
    const task = tasks.find(t => t.profile.id === profile.id);
    const evaluation = state.evaluations.find(e => e.id === task?.evaluationId && equivalent(e, anchor));
    return { profile, task, evaluation };
  });
  const ids = [...new Set(evaluations.flatMap(({ evaluation }) => (evaluation?.results || []).map(r => r.variableId)))];
  const results = ids.map(variableId => {
    const available = evaluations.flatMap(({ evaluation }) => evaluation?.results.filter(r => r.variableId === variableId) || []);
    const first = available[0];
    const ref = anchor.catalogVersions?.find(v => v.id === variableId);
    const definition = state.catalogVersions?.find(v => v.itemId === variableId && v.version === ref?.version)?.snapshot;
    const type = first.type || definition?.type;
    // Numeric metrics and categorical/list descriptors never enter binary voting.
    if (['Métrica', 'Descriptor'].includes(type)) return available.find(r => r.status === 'evaluado' && !r.error) || first;
    if (['Código', 'Cálculo'].includes(first.method)) return { ...first, comparison: { codeOnly: true, label: 'Calculado por Pulso · sin votos de IA', cells: [] } };
    const cells = evaluations.map(({ profile, task, evaluation }) => ({
      profileId: profile.id, label: profile.label, provider: evaluation?.provider || profile.provider,
      model: evaluation?.model || profile.model, requestedModel: profile.model,
      status: evaluation?.results.find(r => r.variableId === variableId)?.error ? 'failed' : evaluation?.results.some(r => r.variableId === variableId) ? 'completed' : task?.status || 'pending', error: evaluation?.results.find(r => r.variableId === variableId)?.error || (!evaluation ? task?.error || null : null),
      result: evaluation?.results.find(r => r.variableId === variableId) || null,
      createdAt: evaluation?.createdAt || null,
    }));
    const contingencyLabel = cells[0].status === 'failed' && ['AI_UNAVAILABLE', 'AI_TRANSIENT', 'INVALID_AI_RESULT', 'AI_INCOMPLETE'].includes(cells[0].error?.code) && cells[1].result ? `Evaluado con ${cells[1].label} · respaldo de ${cells[0].label}` : null;
    const seen = new Set();
    const votes = cells.filter(c => {
      const identity = `${c.provider}:${c.model}`;
      if (!conclusive(c.result) || c.result.error || c.result.codeRule || ['Código', 'Cálculo'].includes(c.result.method) || seen.has(identity)) return false;
      seen.add(identity); return true;
    });
    const detections = votes.filter(c => c.result.value === 1).length;
    const missing = cells.filter(c => !conclusive(c.result)).length;
    const imposed = cells.some(c => c.result?.codeRule);
    const agreement = imposed ? 'rule' : votes.length === 2 && detections === 2 ? 'agree-positive'
      : votes.length === 2 && detections === 0 ? 'agree-negative' : votes.length === 2 ? 'disagree' : 'incomplete';
    const label = ({ rule: 'Resultado con regla de código · sin consenso independiente', 'agree-positive': 'Detectado por 2 modelos',
      'agree-negative': 'Ningún modelo detecta el evento', disagree: 'Discrepancia · requiere revisión',
      incomplete: `${detections} detección${detections === 1 ? '' : 'es'} · comparación incompleta` })[agreement];
    const positives = available.filter(r => conclusive(r) && r.value === 1);
    const allNegative = cells.every(c => conclusive(c.result) && c.result.value === 0);
    const result = positives[0] || first;
    const evidence = [...new Map(positives.flatMap(r => r.evidence || []).map(e => [`${e.messageId}:${e.quote}`, e])).values()];
    const evidenceSets = positives.map(r => new Set((r.evidence || []).map(e => e.messageId)));
    const commonEvidence = evidenceSets.length > 1 && [...evidenceSets[0]].some(id => evidenceSets.every(set => set.has(id)));
    return { ...result, status: positives.length || allNegative ? 'evaluado' : 'no_evaluado', value: positives.length ? 1 : allNegative ? 0 : null,
      evidence: positives.length ? evidence : [], comparison: { cells, contingencyLabel, detections, votes: votes.length, expected: 2, missing, agreement, label, commonEvidence } };
  });
  return { ...anchor, dual: true, results, modelReviewPending: tasks.some(t => ['pending', 'running', 'partial', 'failed'].includes(t.status)) };
}
