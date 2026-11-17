import { createThursdayCollector } from './thursday.js';

export const POLL_MS = 30_000;
export const COMPLETION_ID = '8fa643d2-0c32-4cbc-88da-14959ff877cd';
export const RECOVERY_ID = '5db71f86-2186-49a8-b715-722f93e8fc41';
export const RECOVERY_JOBS = ['340c1fcb-dc19-42a2-91af-e494eb52d753', 'ee30980f-df37-4592-bae9-3090f49f5e3e'];
export const STALE_ACTIVITY_MS = 10 * 60_000;
export const MODELS = [{ id: 'clef-local', label: 'Clef', model: 'clef-flash', total: 210 }, { id: 'gemma-local', label: 'Gemma', model: 'gemma-4-26b-a4b-it-mlx', total: 212 }];
export class MonitorError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

export function portalBase(pathname) {
  const match = pathname.match(/^(\/[^?#]+)\/monitor-evaluaciones(?:\/index\.html|\/)?$/);
  if (!match || match[1].includes('..')) throw new MonitorError('Abre este monitor desde la dirección publicada de Pulso.');
  return match[1];
}

export function createApi(base, fetchImpl = fetch) {
  return async (path, signal) => {
    let response;
    try { response = await fetchImpl(`${base}/api${path}`, { credentials: 'same-origin', cache: 'no-store', signal, headers: { Accept: 'application/json' } }); }
    catch (error) { if (signal?.aborted) throw error; throw new MonitorError('No pudimos actualizar el avance. Conservamos la última lectura.'); }
    if (response.status === 401) throw new MonitorError('Tu sesión venció. Inicia sesión en Pulso y vuelve a actualizar este monitor.', 401);
    if (response.status === 403) throw new MonitorError('Este monitor está disponible para administradores de Pulso.', 403);
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new MonitorError('El servidor no respondió correctamente. Conservamos la última lectura.', response.status);
    try { return await response.json(); } catch { throw new MonitorError('La respuesta llegó incompleta. Conservamos la última lectura.'); }
  };
}

export function createPoller({ collect, onStart, onData, onError, onEnd, schedule = setTimeout, cancel = clearTimeout, interval = POLL_MS }) {
  let timer = null, controller = null, stopped = false, automatic = true;
  const refresh = async () => {
    if (stopped || controller) return;
    if (timer !== null) { cancel(timer); timer = null; }
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 45_000);
    onStart?.();
    try {
      const snapshot = await collect(controller.signal);
      // Keep watching even between finished batches: more loads can arrive.
      if (!stopped) onData?.(snapshot);
    } catch (error) {
      if (!stopped) { if ([401, 403].includes(error.status)) automatic = false; onError?.(error.name === 'AbortError' ? new MonitorError('La consulta tardó demasiado. Conservamos la última lectura.') : error); }
    } finally {
      clearTimeout(timeout); controller = null;
      if (!stopped) { onEnd?.(); if (automatic) timer = schedule(refresh, interval); }
    }
  };
  return { refresh, stop() { stopped = true; cancel(timer); controller?.abort(); } };
}

const statuses = ['completed', 'partial', 'failed', 'running', 'pending'];
const blank = () => Object.fromEntries(statuses.map(status => [status, 0]));
const add = (to, from) => statuses.forEach(status => { to[status] += from[status]; });
const invalid = () => { throw new MonitorError('No pudimos verificar el avance de esta recuperación. Conservamos la última lectura.'); };
function readProgress(job, expected) {
  if (job.purpose !== 'operational' || !Array.isArray(job.conversationIds) || job.conversationIds.length !== expected
    || new Set(job.conversationIds).size !== expected || !Array.isArray(job.modelProfiles) || job.modelProfiles.length !== 2
    || MODELS.some(model => !job.modelProfiles.some(profile => profile.id === model.id)) || !Array.isArray(job.modelProgress)) invalid();
  return MODELS.map(model => {
    const entries = job.modelProgress.filter(progress => progress.profileId === model.id), entry = entries[0];
    if (entries.length !== 1 || entry.total !== expected || statuses.some(status => !Number.isSafeInteger(entry[status]) || entry[status] < 0)
      || statuses.reduce((total, status) => total + entry[status], 0) !== expected) invalid();
    return { id: model.id, label: model.label, total: expected, ...Object.fromEntries(statuses.map(status => [status, entry[status]])) };
  });
}
export function summarize(payload, observedAt = new Date().toISOString()) {
  if (!Array.isArray(payload?.jobs)) throw new MonitorError('El avance recibido no tiene un formato válido.');
  const run = payload.settings?.tuesdayWednesdayCompletion;
  if (run && run.id !== COMPLETION_ID) invalid();
  const models = MODELS.map(model => ({ ...model, ...blank(), active: false }));
  const phases = [
    { key: 'tuesday', code: 'MAR', name: 'Martes 10 de noviembre', target: 169, totalReviews: 336, newCases: 167, unassigned: 167, counts: blank() },
    { key: 'wednesday', code: 'MIÉ', name: 'Miércoles 11 de noviembre', target: 43, totalReviews: 86, newCases: 43, unassigned: 43, counts: blank() },
  ];
  const batches = [], participating = [], seenConversations = new Set(), retry = blank();
  for (const [index, id] of RECOVERY_JOBS.entries()) {
    const jobs = payload.jobs.filter(job => job.id === id); if (jobs.length !== 1) invalid();
    const job = jobs[0], progress = readProgress(job, index ? 312 : 52);
    for (const id of job.conversationIds) { if (seenConversations.has(id)) invalid(); seenConversations.add(id); }
    add(retry, progress.find(model => model.id === 'gemma-local'));
    participating.push({ job, remaining: progress.find(model => model.id === 'gemma-local').total - progress.find(model => model.id === 'gemma-local').completed });
  }
  // The old jobs already held 362 complete Gemma answers. Only the remaining
  // two belong to this recovery. The excluded old Clef task is never counted.
  retry.completed -= 362;
  if (retry.completed < 0 || statuses.reduce((sum, status) => sum + retry[status], 0) !== 2) invalid();
  add(models[1], retry); add(phases[0].counts, retry);
  batches.push({ id: 'prior-gemma-retries', label: 'Dos pendientes anteriores del martes', cases: 2,
    models: [{ id: 'gemma-local', label: 'Gemma', total: 2, ...retry }] });
  for (const phase of phases) {
    const jobs = payload.jobs.filter(job => job.idempotencyKey === `${COMPLETION_ID}:${phase.key}`);
    if (jobs.length > 1) invalid();
    const job = jobs[0];
    if (!job) {
      for (const model of models) model.pending += phase.newCases;
      phase.counts.pending += phase.newCases * 2;
      continue;
    }
    const progress = readProgress(job, phase.newCases);
    for (const id of job.conversationIds) { if (seenConversations.has(id)) invalid(); seenConversations.add(id); }
    for (const entry of progress) { add(models.find(model => model.id === entry.id), entry); add(phase.counts, entry); }
    phase.unassigned = 0;
    batches.push({ id: job.id, label: `${phase.name} · lote nuevo`, cases: phase.newCases, models: progress });
    participating.push({ job, remaining: progress.reduce((sum, model) => sum + model.total - model.completed, 0) });
  }
  const now = Date.parse(observedAt), times = [...participating.map(({ job }) => job.updatedAt || job.createdAt), run?.updatedAt, run?.preparedAt]
    .filter(value => Number.isFinite(Date.parse(value)));
  const activity = times.sort().at(-1) || null;
  const runningJobs = participating.filter(({ job, remaining }) => job.status === 'running' && remaining > 0);
  const activeJobs = runningJobs.filter(({ job }) => now - Date.parse(job.updatedAt || job.createdAt) <= STALE_ACTIVITY_MS);
  for (const model of models) {
    if (model.completed > model.total || statuses.reduce((sum, status) => sum + model[status], 0) !== model.total) invalid();
    model.active = model.running > 0 && activeJobs.some(({ job }) => RECOVERY_JOBS.includes(job.id)
      ? model.id === 'gemma-local' : job.modelProgress.some(progress => progress.profileId === model.id && progress.running > 0));
    model.percent = model.completed / model.total * 100;
    model.status = model.active ? 'En curso' : model.completed === model.total ? 'Completado' : model.partial || model.failed ? 'Con incidencias' : 'Pendiente';
  }
  const counts = blank(); models.forEach(model => add(counts, model));
  const finished = counts.completed === 422 && run?.status === 'completed';
  const runActive = ['prepared', 'running'].includes(run?.status);
  const stalled = !finished && (runningJobs.length > activeJobs.length || runActive && !!activity && now - Date.parse(activity) > STALE_ACTIVITY_MS);
  return { ...counts, total: 422, target: 212, requested: 213, excluded: 1, preserved: 725,
    concurrency: [1, 2].includes(run?.concurrency) ? run.concurrency : 1, percent: counts.completed / 422 * 100, models, phases, batches, observedAt, activity, finished,
    unassigned: phases.reduce((sum, phase) => sum + phase.unassigned, 0),
    preparing: !finished && !stalled && !runningJobs.length && runActive && counts.pending > 0,
    runStatus: run?.status || null, waitingThursday: run?.status === 'waiting_thursday',
    priorityOrder: run?.priority?.order || null, resumeTuesday: run?.priority?.resumeTuesday || null,
    tuesdayDeadline: run?.priority?.deadline || null, tuesdayBlocked: !!run?.priority?.tuesdayBlocked,
    blocked: run?.status === 'blocked', interrupted: run?.status !== 'waiting_thursday' && participating.some(({ job }) => !RECOVERY_JOBS.includes(job.id) && job.status === 'interrupted'),
    stalled,
    paused: !finished && !runningJobs.length && !!payload.settings?.evaluationMaintenance && payload.settings.evaluationMaintenance !== RECOVERY_ID,
  };
}
export function createCollector(api) {
  const collectThursday = createThursdayCollector(api);
  return async signal => {
    const payload = await api('/evaluations', signal);
    const observedAt = new Date().toISOString();
    const thursday = await collectThursday(payload, signal, observedAt);
    return { ...summarize(payload, observedAt), thursday };
  };
}
