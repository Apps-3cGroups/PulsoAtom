export const POLL_MS = 30_000;
export const RUN_DATE = '2026-11-11';
export const ACTIVITY_DATE = '2026-11-10';
// Verified ready conversations for this activity date: HN 367, PA 164.
// Apply the daily country cap; later assigned batches can raise the PA target.
export const COUNTRIES = [{ code: 'HN', name: 'Honduras', target: 200 }, { code: 'PA', name: 'Panamá', target: 164 }];
export const MODELS = [{ id: 'clef-local', label: 'Clef', model: 'clef-flash' }, { id: 'gemma-local', label: 'Gemma', model: 'gemma-4-26b-a4b-it-mlx' }];
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
const terminal = new Set(['completed', 'partial', 'failed']);
const blank = () => Object.fromEntries(statuses.map(s => [s, 0]));
const processed = value => value.completed + value.partial + value.failed;
const add = (to, from) => statuses.forEach(s => { to[s] += from[s]; });

export function summarize(payload, observedAt = new Date().toISOString()) {
  if (!Array.isArray(payload?.jobs)) throw new MonitorError('El avance recibido no tiene un formato válido.');
  const jobs = payload.jobs.filter(j => j.dailyActivity?.date === ACTIVITY_DATE
    && j.dailyActivity.timezone === 'America/Tegucigalpa' && j.purpose === 'operational');
  const countries = COUNTRIES.map(c => ({ ...c, assigned: 0, deferred: 0, counts: blank(), modelBreakdownAvailable: true }));
  const models = MODELS.map(m => ({ ...m, ...blank(), active: false }));
  const seenJobs = new Set(), seenConversations = new Set(), deferred = new Set();
  const batches = [];
  for (const job of jobs) {
    if (seenJobs.has(job.id) || !Array.isArray(job.conversationIds) || !Array.isArray(job.modelProgress)
      || !Array.isArray(job.modelProfiles) || job.modelProfiles.length !== 2
      || MODELS.some(m => !job.modelProfiles.some(p => p.id === m.id))) throw new MonitorError('No pudimos verificar los modelos de esta corrida.');
    seenJobs.add(job.id);
    const members = new Map();
    for (const id of job.conversationIds) {
      const code = job.conversationCountries?.[id], country = countries.find(c => c.code === code);
      if (!country || seenConversations.has(id)) throw new MonitorError('No pudimos verificar el país o la unicidad de las conversaciones.');
      seenConversations.add(id); country.assigned++;
      members.set(code, (members.get(code) || 0) + 1);
    }
    for (const id of job.deferredConversationIds || []) {
      if (!deferred.has(id)) {
        deferred.add(id);
        const country = countries.find(c => c.code === job.conversationCountries?.[id]);
        if (country) country.deferred++;
      }
    }
    const progress = MODELS.map(model => {
      const entries = job.modelProgress.filter(p => p.profileId === model.id), entry = entries[0];
      if (entries.length !== 1 || entry.total !== job.conversationIds.length
        || statuses.some(s => !Number.isSafeInteger(entry[s]) || entry[s] < 0)
        || statuses.reduce((sum, s) => sum + entry[s], 0) !== entry.total) throw new MonitorError('El detalle de un modelo está incompleto; conservamos la última lectura.');
      const counts = Object.fromEntries(statuses.map(s => [s, entry[s]]));
      add(models.find(m => m.id === model.id), counts);
      return { id: model.id, label: model.label, ...counts, processed: processed(counts), total: entry.total };
    });
    if (members.size === 1) {
      const country = countries.find(c => c.code === [...members.keys()][0]);
      progress.forEach(p => add(country.counts, p));
    } else if (members.size > 1) {
      for (const code of members.keys()) countries.find(c => c.code === code).modelBreakdownAvailable = false;
    }
    if (job.status === 'running') {
      const phase = job.modelProfiles.find(p => {
        const m = progress.find(m => m.id === p.id); return m.running > 0 || m.pending > 0;
      });
      if (phase) models.find(m => m.id === phase.id).active = true;
    }
    if (job.conversationIds.length) batches.push({ id: job.id, status: job.status, countries: [...members.keys()], cases: job.conversationIds.length,
      createdAt: job.createdAt, models: progress, updatedAt: job.updatedAt });
  }
  for (const country of countries) {
    country.target = Math.max(country.target, country.assigned);
    country.unassigned = country.target - country.assigned;
    country.counts.pending += country.unassigned * MODELS.length;
    country.processed = processed(country.counts);
    country.totalReviews = country.target * MODELS.length;
  }
  const target = countries.reduce((sum, c) => sum + c.target, 0);
  const unassigned = countries.reduce((sum, c) => sum + c.unassigned, 0);
  for (const model of models) {
    model.pending += unassigned; model.total = target; model.processed = processed(model);
    model.percent = model.processed / target * 100;
    model.status = model.running > 0 || model.active ? 'En curso' : model.pending > 0 ? 'Pendiente' : model.partial || model.failed ? 'Terminó con incidencias' : 'Terminado';
  }
  const counts = blank(); models.forEach(m => add(counts, m));
  const activity = jobs.map(j => j.updatedAt || j.createdAt).filter(v => Number.isFinite(Date.parse(v))).sort().at(-1) || null;
  const total = target * MODELS.length, done = processed(counts);
  return { ...counts, processed: done, total, target, unassigned, percent: done / total * 100, countries, models, batches,
    observedAt, activity, finished: done === total && jobs.every(j => terminal.has(j.status)),
    interrupted: jobs.some(j => j.status === 'interrupted'), paused: !!payload.settings?.evaluationMaintenance,
    deferred: deferred.size, date: ACTIVITY_DATE };
}

export function createCollector(api) {
  return async signal => {
    // The endpoint enforces the existing administrator session. One request
    // supplies a consistent snapshot without downloading attempts or answers.
    return summarize(await api('/evaluations', signal));
  };
}
