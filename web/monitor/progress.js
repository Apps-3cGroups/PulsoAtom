export const COHORT_ID = 'clef-complement-77f134e8-fdf8-4154-b1f6-485c159b9194';
export const TOTAL = 500;
export const POLL_MS = 30_000;
const terminal = new Set(['completed', 'partial', 'failed']);
const validStatuses = new Set([...terminal, 'running', 'pending', 'interrupted', 'queued']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class MonitorError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

export function portalBase(pathname) {
  const match = pathname.match(/^(\/[^?#]+)\/monitor-clef(?:\/index\.html|\/)?$/);
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

function selectJobs(jobs) {
  if (!Array.isArray(jobs)) throw new MonitorError('El avance recibido no tiene un formato válido.');
  const selected = jobs.filter(job => job.cohortId === COHORT_ID);
  const seen = new Set();
  for (const job of selected) {
    if (!uuid.test(job.id) || seen.has(job.id) || !Array.isArray(job.conversationIds)
      || job.conversationIds.length < 1 || job.conversationIds.length > 20
      || new Set(job.conversationIds).size !== job.conversationIds.length) throw new MonitorError('El lote no pudo verificarse. Conservamos la última lectura.');
    seen.add(job.id);
  }
  return selected.sort((a, b) => a.cohortBatchIndex - b.cohortBatchIndex);
}

export function sanitizeTasks(job, payload) {
  if (!Array.isArray(payload?.tasks)) throw new MonitorError('No pudimos verificar las revisiones del lote.');
  const byConversation = new Map();
  for (const task of payload.tasks) {
    if (task.profile?.id !== 'clef-local') continue;
    if (task.jobId !== job.id || !job.conversationIds.includes(task.conversationId) || !validStatuses.has(task.status)) throw new MonitorError('El lote contiene una revisión que no pudimos verificar.');
    const existing = byConversation.get(task.conversationId);
    if (existing && (existing.id !== task.id || existing.status !== task.status)) throw new MonitorError('Hay revisiones duplicadas del lote. Conservamos la última lectura.');
    // Retain only counts metadata. Provider responses, error messages, profiles,
    // attempts and source content never enter the monitor state.
    byConversation.set(task.conversationId, { id: task.id, conversationId: task.conversationId, status: task.status });
  }
  if (byConversation.size !== job.conversationIds.length) throw new MonitorError('El lote está incompleto en esta lectura. Volveremos a consultarlo.');
  return [...byConversation.values()];
}

export function summarize(jobs, tasksByJob, observedAt = new Date().toISOString()) {
  const selected = selectJobs(jobs);
  const seen = new Set();
  const counts = { completed: 0, partial: 0, failed: 0, running: 0, pending: 0 };
  const batches = selected.map(job => {
    const tasks = tasksByJob.get(job.id);
    if (!tasks) throw new MonitorError('Todavía falta leer parte del lote.');
    const batch = { id: job.id, index: job.cohortBatchIndex + 1, status: job.status, total: job.conversationIds.length, completed: 0, partial: 0, failed: 0, running: 0, pending: 0 };
    for (const task of tasks) {
      if (seen.has(task.conversationId)) throw new MonitorError('Una conversación aparece en más de un lote. Conservamos la última lectura.');
      seen.add(task.conversationId);
      const status = ['completed', 'partial', 'failed', 'running'].includes(task.status) ? task.status : 'pending';
      batch[status]++; counts[status]++;
    }
    return batch;
  });
  if (seen.size > TOTAL) throw new MonitorError('El universo recibido supera las 500 conversaciones previstas.');
  counts.pending += TOTAL - seen.size;
  const processed = counts.completed + counts.partial + counts.failed;
  const activity = selected.map(job => job.updatedAt || job.createdAt).filter(value => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
  return { ...counts, total: TOTAL, processed, percent: processed / TOTAL * 100, observedAt, activity,
    batches, finished: seen.size === TOTAL && processed === TOTAL && selected.every(job => terminal.has(job.status)),
    interrupted: selected.some(job => job.status === 'interrupted') };
}

async function concurrent(items, limit, work) {
  let index = 0, failure;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && index < items.length) {
      const item = items[index++];
      try { await work(item); } catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
}

export function createCollector(api) {
  let cache = new Map();
  return async signal => {
    const session = await api('/auth/me', signal);
    if (session?.user?.role !== 'admin') throw new MonitorError('Este monitor está disponible para administradores de Pulso.', 403);
    const result = await api('/evaluations', signal);
    const jobs = selectJobs(result.jobs);
    const next = new Map();
    await concurrent(jobs, 2, async job => {
      const stamp = `${job.updatedAt || ''}:${job.status}`;
      const saved = cache.get(job.id);
      const tasks = saved?.stamp === stamp ? saved.tasks : sanitizeTasks(job, await api(`/evaluations/${job.id}/attempts`, signal));
      next.set(job.id, { stamp, tasks });
    });
    const snapshot = summarize(jobs, new Map([...next].map(([id, value]) => [id, value.tasks])));
    // Atomic commit: a partial refresh must not overwrite the last valid cache.
    cache = next;
    return snapshot;
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
      if (!stopped) { automatic = !snapshot.finished; onData(snapshot); }
    } catch (error) {
      if (!stopped) { if ([401, 403].includes(error.status)) automatic = false; onError(error.name === 'AbortError' ? new MonitorError('La consulta tardó demasiado. Conservamos la última lectura.') : error); }
    } finally {
      clearTimeout(timeout); controller = null;
      if (!stopped) { onEnd?.(); if (automatic) timer = schedule(refresh, interval); }
    }
  };
  return { refresh, stop() { stopped = true; cancel(timer); controller?.abort(); } };
}
