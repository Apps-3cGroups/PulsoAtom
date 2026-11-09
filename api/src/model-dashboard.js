import { AppError } from './errors.js';
import { sourceFingerprint } from './evaluation-context.js';

const contextKeys = ['sourceHash', 'catalogHash', 'promptHash', 'rulesVersion'];
const profileKey = p => p.viewId || `${p.id}@${p.configurationHash || p.model}`;
const sameContext = (a, b) => contextKeys.every(key => a?.[key] && a[key] === b?.[key]);
const ratio = (n, total) => total ? n / total : null;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const aiFlag = v => v?.type === 'Flag' && ['IA', 'IA + código'].includes(v.method);
const rawResult = result => result?.codeRule ? result.aiResult : result;
const decisive = result => result?.status === 'evaluado' && !result.error && [0, 1].includes(result.value);
const dateInZone = (value, timezone) => {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type).value).join('-');
};

/** Read-only analytics: latest paired operational run per conversation, immutable checklist. */
export function modelDashboard(state, registry, filters = {}, timezone = 'America/Tegucigalpa') {
  const jobs = (state.jobs || []).filter(j => j.purpose !== 'comparison').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const profileMap = new Map();
  const addProfile = p => {
    const id = profileKey(p);
    if (!profileMap.has(id)) profileMap.set(id, { id, profileId: p.id, label: p.label, model: p.model, provider: p.provider, demo: !!p.demo });
  };
  // Prefer profiles with actual saved runs, then include configured models for empty states.
  for (const job of jobs) for (const p of job.modelProfiles || []) addProfile(p);
  for (const p of registry.list()) addProfile(p);
  const profiles = [...profileMap.values()];
  const localIds = ['clef-local', 'gemma-local'];
  const localJob = jobs.find(j => localIds.every(id => j.modelProfiles?.some(p => p.id === id)));
  const localPair = localIds.map(id => localJob ? profileKey(localJob.modelProfiles.find(p => p.id === id)) : profiles.find(p => p.profileId === id)?.id);
  const defaultPair = localPair.every(Boolean) ? localPair : jobs.find(j => j.modelProfiles?.length >= 2)?.modelProfiles.map(profileKey);
  const left = filters.left || defaultPair?.[0] || profiles[0]?.id;
  const first = profileMap.get(left);
  const right = filters.right || (defaultPair?.[0] === left ? defaultPair[1] : profiles.find(p => p.id !== left && !(p.provider === first?.provider && p.model === first?.model))?.id);
  if ((filters.left && !first) || (filters.right && !profileMap.has(right))) throw new AppError(422, 'Modelo no disponible en el histórico.', 'INVALID_MODEL');
  const second = profileMap.get(right);
  if (first && second && (first.id === second.id || (first.provider === second.provider && first.model === second.model))) throw new AppError(422, 'Selecciona dos modelos diferentes.', 'DUPLICATE_MODEL');
  const selected = [first, second].filter(Boolean);
  const conversations = new Map((state.conversations || []).map(c => [c.id, c]));
  const snapshots = new Map((state.catalogVersions || []).map(v => [`${v.itemId}:${v.version}`, v.snapshot]));
  const evaluations = new Map((state.evaluations || []).map(e => [e.id, e]));
  const tasksByJob = new Map();
  for (const task of state.tasks || []) {
    if (!task.profile) continue;
    if (!tasksByJob.has(task.jobId)) tasksByJob.set(task.jobId, new Map());
    const cases = tasksByJob.get(task.jobId);
    if (!cases.has(task.conversationId)) cases.set(task.conversationId, new Map());
    cases.get(task.conversationId).set(profileKey(task.profile), task);
  }
  const verdicts = new Map();
  for (const v of state.verdicts || []) verdicts.set(JSON.stringify([v.conversationId, v.sourceHash, v.variableId, v.catalogVersion]), v);
  const eligibleJobs = jobs.filter(j => selected.length === 2 && selected.every(p => j.modelProfiles?.some(s => profileKey(s) === p.id)));
  if (filters.jobId && !eligibleJobs.some(j => j.id === filters.jobId)) throw new AppError(422, 'La ejecución no corresponde a los modelos seleccionados.', 'INVALID_JOB');
  const countries = [...new Set([...conversations.values()].map(c => c.country).filter(Boolean))].sort();
  const cohort = new Map(), candidates = new Set();
  let invalidContexts = 0, missingCatalog = 0;
  for (const job of jobs) {
    const day = dateInZone(job.createdAt, timezone);
    if (!day || (filters.from && day < filters.from) || (filters.to && day > filters.to) || (filters.jobId && job.id !== filters.jobId)) continue;
    if (!job.modelProfiles?.some(p => selected.some(s => s.id === profileKey(p)))) continue;
    const cases = tasksByJob.get(job.id) || new Map();
    for (const [conversationId, tasks] of cases) {
      const conversation = conversations.get(conversationId);
      if (filters.country && conversation?.country !== filters.country) continue;
      candidates.add(conversationId);
      if (cohort.has(conversationId) || selected.length !== 2) continue;
      const pair = selected.map(p => tasks.get(p.id));
      if (pair.some(t => !t)) continue;
      if (!sameContext(pair[0].context, pair[1].context)) { invalidContexts++; continue; }
      const refs = (job.catalogVersions || []).filter(v => v.active);
      if (!refs.length || refs.some(v => !snapshots.has(`${v.id}:${v.version}`))) { missingCatalog++; continue; }
      const variables = refs.map(v => snapshots.get(`${v.id}:${v.version}`)).filter(aiFlag);
      if (!variables.length) continue;
      const cells = pair.map(task => {
        const saved = evaluations.get(task.evaluationId);
        const compatible = saved && sameContext(saved, task.context) && saved.profileId === task.profile.id && !saved.usedFallback
          && saved.provider === task.profile.provider && (!saved.modelConfiguration || profileKey(saved.modelConfiguration) === profileKey(task.profile));
        const evaluation = compatible ? saved : null;
        return { task, evaluation, results: new Map((evaluation?.results || []).map(r => [r.variableId, rawResult(r)])) };
      });
      cohort.set(conversationId, { conversationId, conversation, job, variables, cells, context: pair[0].context });
    }
  }
  const cases = [...cohort.values()];
  const metrics = selected.map(profile => ({ ...profile, total: 0, answered: 0, detected: 0, absent: 0, abstained: 0, failedFlags: 0, pending: 0,
    completed: 0, partial: 0, failed: 0, inProgress: 0, fallback: 0, tp: 0, fp: 0, fn: 0, tn: 0, validated: 0 }));
  const flagCounts = new Map(), timedPairs = [];
  let agreement = 0, jointAnswered = 0, referenceCount = 0;
  for (const item of cases) {
    const times = item.cells.map(({ task, evaluation }) => evaluation && ['completed', 'partial'].includes(task.status)
      && Number.isFinite(evaluation.durationMs) && evaluation.durationMs >= 0 ? evaluation.durationMs : null);
    // Identical timing cohort for both providers, with failures visible in coverage KPIs.
    if (times.every(t => t !== null)) timedPairs.push({ conversationId: item.conversationId, times });
    item.cells.forEach(({ task, evaluation }, i) => {
      if (task.status === 'completed' && evaluation) metrics[i].completed++;
      else if (task.status === 'partial' && evaluation) metrics[i].partial++;
      else if (['pending', 'running'].includes(task.status)) metrics[i].inProgress++;
      else metrics[i].failed++;
      if (evaluations.get(task.evaluationId)?.usedFallback) metrics[i].fallback++;
    });
    const currentSource = item.conversation && sourceFingerprint(item.conversation) === item.context.sourceHash;
    for (const variable of item.variables) {
      const key = `${variable.id}:${variable.version}`;
      flagCounts.set(key, (flagCounts.get(key) || 0) + 1);
      const results = item.cells.map(cell => cell.results.get(variable.id));
      results.forEach((r, i) => {
        const m = metrics[i]; m.total++;
        if (decisive(r)) {
          m.answered++;
          if (r.value === 1) { m.detected++; } else m.absent++;
        } else {
          m.pending++;
          if (r?.status === 'no_evaluado' && !r.error) m.abstained++; else m.failedFlags++;
        }
      });
      const distinctModels = item.cells.every(c => c.evaluation) && new Set(item.cells.map(c => `${c.evaluation.provider}:${c.evaluation.model}`)).size === 2;
      const bothAnswered = distinctModels && results.every(decisive);
      if (bothAnswered) { jointAnswered++; if (results[0].value === results[1].value) agreement++; }
      const verdict = verdicts.get(JSON.stringify([item.conversationId, item.context.sourceHash, variable.id, variable.version]));
      if (!currentSource || verdict?.mode !== 'blind' || !['present', 'absent'].includes(verdict.outcome)) continue;
      referenceCount++;
      if (!bothAnswered) continue;
      results.forEach((r, i) => {
        const m = metrics[i], present = verdict.outcome === 'present'; m.validated++;
        if (r.value === 1 && present) m.tp++; else if (r.value === 1) m.fp++; else if (present) m.fn++; else m.tn++;
      });
    }
  }
  metrics.forEach((m, i) => {
    const ordered = timedPairs.map(p => ({ conversationId: p.conversationId, durationMs: p.times[i] })).sort((a, b) => a.durationMs - b.durationMs);
    const times = ordered.map(p => p.durationMs);
    Object.assign(m, { coverage: ratio(m.answered, m.total), completionRate: ratio(m.completed, cases.length),
      averageMs: mean(times), medianMs: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : null,
      p95Ms: times.length ? times[Math.ceil(times.length * .95) - 1] : null, minMs: times[0] ?? null, maxMs: times.at(-1) ?? null,
      fastest: ordered[0] || null, slowest: ordered.at(-1) || null, accuracy: ratio(m.tp + m.tn, m.validated),
      precision: ratio(m.tp, m.tp + m.fp), recall: ratio(m.tp, m.tp + m.fn) });
  });
  const counts = cases.map(c => c.variables.length);
  // A one-case aggregate reveals individual predictions. Preserve blind-validation
  // integrity when a flag version occurs in only one conversation in this view.
  const exposureContexts = cases.filter(c => c.variables.some(v => flagCounts.get(`${v.id}:${v.version}`) === 1))
    .map(c => ({ conversationId: c.conversationId, ...c.context, catalogVersions: c.job.catalogVersions }));
  return { generatedAt: new Date().toISOString(), demo: !!state.metadata?.demo, timezone, profiles, countries,
    exposureContexts,
    selected: { left: first?.id || null, right: second?.id || null },
    jobs: eligibleJobs.map(j => ({ id: j.id, createdAt: j.createdAt, status: j.status })),
    cohort: { conversations: cases.length, excluded: candidates.size - cases.length, timed: timedPairs.length, withoutTiming: cases.length - timedPairs.length,
      flagsMin: counts.length ? counts.reduce((a, b) => Math.min(a, b)) : null, flagsMax: counts.length ? counts.reduce((a, b) => Math.max(a, b)) : null,
      invalidContexts, missingCatalog, jointAnswered, agreement, agreementRate: ratio(agreement, jointAnswered), referenceCount },
    metrics };
}
