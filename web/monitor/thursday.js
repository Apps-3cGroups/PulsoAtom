import { MonitorError, STALE_ACTIVITY_MS } from './progress.js';

const HANDOFF_ID = 'thursday-2026-11-12-after-recovery';
const DAY = '2026-11-12';
const TZ = 'America/Tegucigalpa';
const COUNTRIES = [{ country: 'HN', label: 'Honduras' }, { country: 'PA', label: 'Panamá' }];
const MODELS = [{ id: 'clef-local', label: 'Clef' }, { id: 'gemma-local', label: 'Gemma' }];
const STATUSES = ['completed', 'partial', 'failed', 'running', 'pending'];
const blank = () => ({ total: 0, completed: 0, partial: 0, failed: 0, running: 0, pending: 0 });
const invalid = () => { throw new MonitorError('No pudimos verificar el avance del jueves. Conservamos la última lectura.'); };
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const sameSet = (values, expected) => Array.isArray(values) && values.length === expected.length
  && new Set(values).size === values.length && expected.every(value => values.includes(value));
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const profileMatches = (a, b) => a && b && ['id', 'provider', 'model', 'configurationHash'].every(key => a[key] === b[key]);
const add = (target, source) => ['total', ...STATUSES].forEach(key => { target[key] += source[key]; });

function handoffOf(payload) {
  if (!Array.isArray(payload?.jobs)) invalid();
  const handoff = payload.settings?.thursdayHandoff;
  if (!handoff) return null;
  if (handoff.id !== HANDOFF_ID || handoff.activityDate !== DAY || handoff.runDate !== '2026-11-13'
    || handoff.timezone !== TZ || !hash(handoff.scopeHash) || handoff.limitPerCountry !== 200
    || ![1, 2].includes(handoff.concurrency) || !['prepared', 'running', 'caught_up', 'completed'].includes(handoff.status)
    || !sameSet(handoff.countries, COUNTRIES.map(row => row.country)) || !sameSet(handoff.modelIds, MODELS.map(row => row.id))
    || !Array.isArray(handoff.profiles) || handoff.profiles.length !== 2) invalid();
  for (const model of MODELS) {
    const profiles = handoff.profiles.filter(profile => profile?.id === model.id);
    if (profiles.length !== 1 || profiles[0].provider !== 'gateway' || !textId(profiles[0].model)
      || !hash(profiles[0].configurationHash) || profiles[0].demo) invalid();
  }
  if (new Set(handoff.profiles.map(profile => profile.model)).size !== 2) invalid();
  return handoff;
}

function checkedJobs(payload, handoff) {
  const jobs = payload.jobs.filter(job => job?.dailyActivity?.handoffId === handoff.id);
  if (new Set(jobs.map(job => job.id)).size !== jobs.length) invalid();
  for (const job of jobs) {
    if (!textId(job.id) || job.purpose !== 'operational' || job.mode !== 'dual' || job.scope !== 'daily'
      || job.dailyActivity.date !== DAY || job.dailyActivity.timezone !== TZ
      || job.dailyActivity.handoffScopeHash !== handoff.scopeHash || job.limitPerCountry !== handoff.limitPerCountry
      || job.concurrency !== handoff.concurrency || !sameSet(job.countries, handoff.countries)
      || !date(job.createdAt) || !date(job.updatedAt) || !Array.isArray(job.conversationIds)
      || job.conversationIds.some(id => !textId(id)) || new Set(job.conversationIds).size !== job.conversationIds.length
      || !record(job.conversationCountries) || !record(job.dailyQuotaCountries)
      || !Array.isArray(job.modelProfiles) || job.modelProfiles.length !== 2
      || !['running', 'completed', 'partial', 'failed', 'interrupted', 'pending'].includes(job.status)
      || job.caseCount !== job.conversationIds.length || job.total !== job.conversationIds.length * 2) invalid();
    for (const expected of handoff.profiles) {
      const profiles = job.modelProfiles.filter(profile => profile?.id === expected.id);
      if (profiles.length !== 1 || !profileMatches(profiles[0], expected)) invalid();
    }
    for (const id of job.conversationIds) {
      // The quota keeps the original country even if the source country is corrected later.
      if (!handoff.countries.includes(job.conversationCountries[id])
        || !Object.hasOwn(job.dailyQuotaCountries, id)) invalid();
    }
  }
  // Creation, rather than the latest heartbeat, decides which source version wins.
  return jobs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}

function sanitizedTasks(response, job) {
  const tasks = response?.tasks;
  if (!Array.isArray(tasks) || tasks.length !== job.conversationIds.length * 2) invalid();
  const members = new Set(job.conversationIds), pairs = new Set(), taskIds = new Set();
  return tasks.map(task => {
    if (!record(task)) invalid();
    const profile = job.modelProfiles.find(profile => profile.id === task.profile?.id);
    const pair = JSON.stringify([task.conversationId, task.profile?.id]);
    if (!textId(task.id) || taskIds.has(task.id) || task.jobId !== job.id || !members.has(task.conversationId)
      || !profileMatches(task.profile, profile) || pairs.has(pair)
      || ![...STATUSES, 'interrupted'].includes(task.status)) invalid();
    pairs.add(pair); taskIds.add(task.id);
    // Deliberately discard attempts, context, errors, evidence and all source data.
    return { conversationId: task.conversationId, profileId: task.profile.id, status: task.status };
  });
}

function modelRows(handoff, rows, activeJobs) {
  return MODELS.map(model => {
    const own = rows.filter(row => row.profileId === model.id), counts = blank();
    for (const row of own) { counts.total++; counts[row.status === 'interrupted' ? 'pending' : row.status]++; }
    return { ...model, model: handoff.profiles.find(profile => profile.id === model.id).model, ...counts,
      percent: counts.total ? counts.completed / counts.total * 100 : 0,
      active: own.some(row => row.status === 'running' && activeJobs.has(row.jobId)) };
  });
}

export function createThursdayCollector(api) {
  // Cache only the small, sanitized status records. The API response is never retained.
  const cache = new Map();
  return async (payload, signal, observedAt = new Date().toISOString()) => {
    const handoff = handoffOf(payload);
    if (!handoff) {
      cache.clear();
      return { enabled: false, status: 'not_prepared', activity: null, active: false, stalled: false,
        concurrency: 1, limitPerCountry: 200, registered: 0, assigned: 0, reused: 0, completed: 0, remaining: 0,
        runningConversations: 0, countries: [], models: [], counts: blank(), batches: [], warnings: [] };
    }
    if (!date(observedAt)) invalid();
    const jobs = checkedJobs(payload, handoff), ids = new Set(jobs.map(job => job.id));
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    const quota = new Map(), latest = new Map();
    for (const job of jobs) {
      for (const [id, country] of Object.entries(job.dailyQuotaCountries)) {
        if (!textId(id) || !handoff.countries.includes(country) || quota.has(id) && quota.get(id) !== country) invalid();
        quota.set(id, country);
      }
      for (const id of job.conversationIds) latest.set(id, job.id);
    }
    for (const country of handoff.countries) if ([...quota.values()].filter(value => value === country).length > handoff.limitPerCountry) invalid();
    const rows = [];
    for (const job of jobs) {
      const signature = JSON.stringify([handoff.scopeHash, job.updatedAt, job.status,
        Array.isArray(job.modelProgress) ? job.modelProgress.map(progress =>
          [progress?.profileId, ...['total', ...STATUSES].map(key => progress?.[key])]) : null,
        job.conversationIds.map(id => [id, job.conversationCountries[id]]), Object.entries(job.dailyQuotaCountries), job.modelProfiles.map(profile =>
          [profile.id, profile.provider, profile.model, profile.configurationHash])]);
      let saved = cache.get(job.id);
      if (saved?.signature !== signature) {
        // /attempts also returns diagnostics; access only its task collection.
        const tasks = job.conversationIds.length
          ? sanitizedTasks(await api(`/evaluations/${encodeURIComponent(job.id)}/attempts`, signal), job) : [];
        saved = { signature, tasks }; cache.set(job.id, saved);
      }
      for (const task of saved.tasks) if (latest.get(task.conversationId) === job.id) rows.push({ ...task, jobId: job.id });
    }
    const now = Date.parse(observedAt), activeJobs = new Set(jobs.filter(job => job.status === 'running'
      && now - Date.parse(job.updatedAt) <= STALE_ACTIVITY_MS).map(job => job.id));
    const models = modelRows(handoff, rows, activeJobs), counts = blank();
    models.forEach(model => add(counts, model));
    const complete = new Set(), running = new Set();
    for (const id of latest.keys()) {
      const pair = rows.filter(row => row.conversationId === id);
      if (pair.length !== 2) invalid();
      if (pair.every(row => row.status === 'completed')) complete.add(id);
      if (pair.some(row => row.status === 'running')) running.add(id);
    }
    const countries = COUNTRIES.map(country => {
      const members = [...quota].filter(([, code]) => code === country.country).map(([id]) => id);
      const assigned = members.filter(id => latest.has(id)).length, reused = members.length - assigned;
      const completed = reused + members.filter(id => complete.has(id)).length;
      return { ...country, registered: members.length, assigned, reused, completed, remaining: members.length - completed,
        running: members.filter(id => running.has(id)).length };
    });
    const registered = quota.size, assigned = latest.size, reused = registered - assigned, completed = reused + complete.size;
    const remaining = registered - completed;
    if (assigned > registered || handoff.status === 'completed' && remaining > 0) invalid();
    const warnings = ['Las cifras corresponden a las conversaciones incorporadas a los lotes; no confirman que la carga de Automations haya terminado.'];
    if (reused) warnings.push('Los resultados previos corresponden a pares completos al incorporar las conversaciones al cupo.');
    if (!jobs.length) warnings.push('Todavía no hay lotes del jueves registrados; la cobertura está pendiente de confirmación.');
    if (rows.some(row => row.status === 'interrupted') || jobs.some(job => job.status === 'interrupted')) warnings.push('Hay revisiones interrumpidas pendientes de reanudación.');
    const activity = [...jobs.map(job => job.updatedAt), handoff.updatedAt, handoff.preparedAt]
      .filter(date).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) || null;
    const batches = jobs.map((job, index) => {
      const own = rows.filter(row => row.jobId === job.id), models = modelRows(handoff, own, activeJobs), counts = blank();
      models.forEach(model => add(counts, model));
      const cases = new Set(own.map(row => row.conversationId)).size;
      return { id: job.id, label: `Jueves 12 de noviembre · lote ${index + 1}`, status: job.status,
        createdAt: job.createdAt, updatedAt: job.updatedAt, cases, originalCases: job.conversationIds.length,
        supersededCases: job.conversationIds.length - cases, models, counts };
    });
    return { enabled: true, status: jobs.length ? handoff.status : 'prepared', activity,
      active: models.some(model => model.active),
      stalled: jobs.some(job => job.status === 'running' && !activeJobs.has(job.id)
        && rows.some(row => row.jobId === job.id && row.status !== 'completed')),
      concurrency: handoff.concurrency, limitPerCountry: handoff.limitPerCountry,
      registered, assigned, reused, completed, remaining, runningConversations: running.size,
      countries, models, counts, batches, warnings };
  };
}
