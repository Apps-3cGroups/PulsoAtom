import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.js';
import { setTimeout as wait } from 'node:timers/promises';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { runDailyTick } from '../src/daily-scheduler.js';
import { activityOnDate, previousDate, dailyActivityRequest } from '../src/daily-activity.js';
import { configureDailyActivity, requestYesterdayActivity } from '../src/configure-daily-activity.js';
import { prepareDailyLimit, applyDailyLimit } from '../src/daily-limit.js';
import { startEvaluationBatch, evaluationModelProgress } from '../src/evaluation-service.js';

function fixture() {
  const state = createState(false), calls = [];
  state.catalog = state.catalog.filter(v => v.active && v.type === 'Flag').slice(0, 1);
  state.settings = { ...state.settings, version: 14, dailyEnabled: true, dailyMode: 'previous-day-activity',
    dailyTime: '00:01', dailyStartedAt: '2026-11-09T23:00:00Z', dailyStartDate: '2026-11-10',
    dailyCountries: ['HN', 'PA'], dailyModelIds: ['clef-local', 'gemma-local'],
    aiPolicy: { mode: 'single', primaryId: 'gemma-local', version: 6 } };
  const store = { async read() { return structuredClone(state); }, async readWithConversations() { return structuredClone(state); },
    async transaction(fn) { const draft = structuredClone(state), value = fn(draft); Object.assign(state, draft); return structuredClone(value); } };
  const registry = new ModelRegistry(['clef-local', 'gemma-local'].map(id => ({ id, label: id, model: id, provider: 'gateway', enabled: true,
    evaluator: { configured: true, async evaluate(c, variables) {
      calls.push([c.id, id]);
      return { model: id, results: variables.map(v => ({ variableId: v.id, status: 'evaluado', value: 0, reason: 'Prueba', evidence: [] })) };
    } } })));
  return { state, store, registry, calls };
}
const conversation = (id, country = 'HN', timestamp = '2026-11-09T06:00:00Z') => ({ id, country, date: '2026-10-01', completed: false,
  startedAt: '2026-10-01T12:00:00Z', lastActivityAt: timestamp,
  messages: [{ id: `${id}-m`, actor: 'cliente', text: 'Hola', timestamp }] });
async function idle(state) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && state.jobs.some(j => j.status === 'running')) await wait(10);
  assert.ok(state.jobs.every(j => j.status !== 'running'));
}

test('actividad usa el día local, incluye chats que continúan hoy y excluye fechas de importación', () => {
  const c = conversation('boundary');
  assert.equal(activityOnDate(c, '2026-11-09', 'America/Tegucigalpa'), true);
  c.lastActivityAt = c.messages[0].timestamp = '2026-11-10T06:00:00Z';
  c.sourceUpdatedAt = '2026-11-09T12:00:00Z';
  assert.equal(activityOnDate(c, '2026-11-09', 'America/Tegucigalpa'), false);
  c.messages.push({ ...c.messages[0], id: 'yesterday', timestamp: '2026-11-10T05:59:59Z' });
  assert.equal(activityOnDate(c, '2026-11-09', 'America/Tegucigalpa'), true);
  assert.equal(previousDate('2027-01-01'), '2026-12-31');
});

test('inicia mañana a las 00:01, incluye todas las abiertas/cerradas HN/PA y ambos modelos sin límite de 100', async () => {
  const { state, store, registry, calls } = fixture();
  state.conversations = Array.from({ length: 103 }, (_, i) => ({ ...conversation(`c${i}`, i % 2 ? 'HN' : 'PA'), completed: i % 3 === 0 }));
  state.conversations.push(conversation('mexico', 'MX'), conversation('old', 'HN', '2026-11-08T23:00:00Z'), conversation('today', 'PA', '2026-11-10T06:00:00Z'));
  assert.equal(await runDailyTick(store, registry, new Date('2026-11-09T20:00:00Z')), null);
  assert.equal(await runDailyTick(store, registry, new Date('2026-11-10T06:00:59Z')), null);
  const job = await runDailyTick(store, registry, new Date('2026-11-10T06:01:00Z'));
  assert.equal(job.caseCount, 103); assert.equal(job.total, 206); assert.equal(job.mode, 'dual');
  assert.equal(job.dailyActivity.date, '2026-11-09');
  await idle(state);
  assert.equal(calls.length, 206);
  for (const c of state.conversations.slice(0, 103)) assert.deepEqual(calls.filter(([id]) => id === c.id).map(([, model]) => model), ['clef-local', 'gemma-local']);
  assert.equal(state.jobs[0].completed, 206);
  assert.equal(await runDailyTick(store, registry, new Date('2026-11-10T07:01:00Z')), null);
  assert.equal(calls.length, 206);
  state.conversations.push(conversation('late', 'PA'));
  const delayed = await runDailyTick(store, registry, new Date('2026-11-10T08:01:00Z'));
  assert.deepEqual(delayed.conversationIds, ['late']);
  await idle(state); assert.equal(calls.length, 208);
  // Evaluation policy for manual jobs is preserved.
  assert.equal(state.settings.aiPolicy.mode, 'single');
});

test('un día sin datos queda registrado una vez y acepta una carga posterior', async () => {
  const { state, store, registry } = fixture();
  assert.equal((await runDailyTick(store, registry, new Date('2026-11-10T06:01:00Z'))).total, 0);
  await idle(state);
  assert.equal(await runDailyTick(store, registry, new Date('2026-11-10T07:01:00Z')), null);
  state.conversations.push(conversation('late'));
  assert.equal((await runDailyTick(store, registry, new Date('2026-11-10T08:01:00Z'))).total, 2);
  await idle(state);
});

test('la revisión puntual de ayer no adelanta ni altera la programación futura, ni duplica conversaciones', async () => {
  const { state, store, registry, calls } = fixture();
  const original = structuredClone(state.settings);
  state.conversations = Array.from({ length: 114 }, (_, i) => conversation(`ayer-${i}`, 'PA', '2026-11-08T15:00:00Z'));
  state.conversations.push(conversation('hoy'), conversation('otro-pais', 'MX', '2026-11-08T15:00:00Z'));
  const options = { activityDate: '2026-11-08', expectedVersion: 14, now: new Date('2026-11-09T23:00:00Z') };
  await requestYesterdayActivity(store, registry, options);
  for (const key of ['dailyTime', 'dailyStartDate', 'dailyStartedAt', 'dailyEnabled', 'dailyCountries', 'dailyModelIds', 'aiPolicy']) assert.deepEqual(state.settings[key], original[key]);
  assert.equal(state.settings.dailyManualRunDate, '2026-11-09');
  assert.equal(calls.length, 0);
  assert.equal((await requestYesterdayActivity(store, registry, { ...options, expectedVersion: 15 })).alreadyRequested, true);
  const job = await runDailyTick(store, registry, options.now);
  assert.equal(job.caseCount, 114); assert.equal(job.total, 228); assert.equal(job.dailyActivity.date, '2026-11-08');
  await idle(state);
  assert.equal(calls.length, 228);
  assert.equal(await runDailyTick(store, registry, options.now), null);
  assert.equal(await runDailyTick(store, registry, new Date('2026-11-10T06:00:00Z')), null);
  const tomorrow = await runDailyTick(store, registry, new Date('2026-11-10T06:01:00Z'));
  assert.deepEqual(tomorrow.conversationIds, ['hoy']);
  await idle(state);
});

test('la solicitud puntual exige ayer, versión vigente, alcance guardado y ningún lote activo', async () => {
  const { state, store, registry } = fixture();
  const options = { activityDate: '2026-11-08', expectedVersion: 14, now: new Date('2026-11-09T23:00:00Z') };
  await assert.rejects(requestYesterdayActivity(store, registry, { ...options, activityDate: '2026-11-09' }), { code: 'INVALID_ACTIVITY_DATE' });
  await assert.rejects(requestYesterdayActivity(store, registry, { ...options, expectedVersion: 13 }), { code: 'VERSION_CONFLICT' });
  state.settings.dailyCountries = ['HN', 'MX'];
  await assert.rejects(requestYesterdayActivity(store, registry, options), { code: 'SCHEDULE_CHANGED' });
  state.settings.dailyCountries = ['HN', 'PA'];
  state.jobs.push({ status: 'running' });
  await assert.rejects(requestYesterdayActivity(store, registry, options), { code: 'EVALUATION_RUNNING' });
  assert.equal(state.settings.version, 14); assert.equal(state.settings.dailyManualRunDate, undefined);
});

test('la transacción impide duplicar la cohorte en dos procesos y detecta cambios de horario', async () => {
  const { state, store, registry, calls } = fixture(); state.conversations = [conversation('c')];
  const options = dailyActivityRequest(state.settings, '2026-11-10');
  const results = await Promise.allSettled([startEvaluationBatch(store, registry, options), startEvaluationBatch(store, registry, options)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'DAILY_ALREADY_STARTED');
  await idle(state); assert.equal(calls.length, 2);
  state.settings.dailyTime = '01:00';
  await assert.rejects(startEvaluationBatch(store, registry, options), { code: 'SCHEDULE_CHANGED' });
});

test('la activación guarda el alcance sin ejecutar IA, requiere versión y fecha futuras y conserva la política manual', async () => {
  const { state, store, registry, calls } = fixture();
  state.settings.dailyEnabled = false;
  const options = { expectedVersion: 14, startDate: '2026-11-10', now: new Date('2026-11-09T20:00:00Z') };
  const result = await configureDailyActivity(store, registry, options);
  assert.equal(result.enabled, true); assert.equal(result.time, '00:01'); assert.equal(result.settingsVersion, 15);
  assert.deepEqual(result.countries, ['HN', 'PA']); assert.deepEqual(result.modelIds, ['clef-local', 'gemma-local']);
  assert.equal(state.settings.aiPolicy.primaryId, 'gemma-local'); assert.equal(state.jobs.length, 0); assert.equal(calls.length, 0);
  await assert.rejects(configureDailyActivity(store, registry, options), { code: 'VERSION_CONFLICT' });
  await assert.rejects(configureDailyActivity(store, registry, { ...options, startDate: '2026-11-09' }), { code: 'INVALID_START_DATE' });
});


test('reanudar una interrupción conserva el primer modelo completado', async () => {
  const { state, store, registry, calls } = fixture(); state.conversations = [conversation('c')];
  const gemma = registry.profiles[1].evaluator, success = gemma.evaluate;
  gemma.evaluate = async () => { throw new AppError(502, 'No disponible', 'AI_UNAVAILABLE'); };
  const job = await runDailyTick(store, registry, new Date('2026-11-10T06:01:00Z'));
  await idle(state);
  assert.equal(state.jobs[0].status, 'partial');
  state.jobs[0].status = 'interrupted';
  gemma.evaluate = success;
  assert.equal((await runDailyTick(store, registry, new Date('2026-11-10T07:01:00Z'))).id, job.id);
  await idle(state);
  assert.deepEqual(calls, [['c', 'clef-local'], ['c', 'gemma-local']]);
  assert.equal(state.jobs[0].completed, 2);
});

test('un contenido cambiado al reanudar queda visible y no bloquea los casos siguientes', async () => {
  const { state, store, registry } = fixture(); state.conversations = [conversation('c')];
  const gemma = registry.profiles[1].evaluator, success = gemma.evaluate;
  gemma.evaluate = async () => { throw new AppError(502, 'No disponible', 'AI_UNAVAILABLE'); };
  await runDailyTick(store, registry, new Date('2026-11-10T06:01:00Z')); await idle(state);
  state.jobs[0].status = 'interrupted'; gemma.evaluate = success;
  state.conversations[0].messages[0].text = 'Contenido actualizado';
  await assert.rejects(runDailyTick(store, registry, new Date('2026-11-10T07:01:00Z')), { code: 'SOURCE_CHANGED' });
  assert.equal(state.jobs[0].dailyResumeError.code, 'SOURCE_CHANGED');
  state.conversations.push(conversation('next'));
  assert.deepEqual((await runDailyTick(store, registry, new Date('2026-11-10T08:01:00Z'))).conversationIds, ['next']);
  await idle(state);
});


test('el cupo por país suma importaciones, se congela en el lote y se renueva al día siguiente', async () => {
  const { state, store, registry, calls } = fixture();
  state.settings.dailyLimitPerCountry = 2;
  state.settings.dailyConcurrency = 2;
  state.conversations = [conversation('hn1')];
  await runDailyTick(store, registry, new Date('2026-11-10T07:00:00Z')); await idle(state);
  state.conversations.push(conversation('hn2'), conversation('hn3'), conversation('pa1', 'PA'), conversation('pa2', 'PA'), conversation('pa3', 'PA'));
  const batch = await runDailyTick(store, registry, new Date('2026-11-10T08:00:00Z')); await idle(state);
  assert.deepEqual(batch.conversationIds, ['hn2', 'pa1', 'pa2']);
  assert.equal(batch.concurrency, 2); assert.equal(calls.length, 8);
  assert.equal(await runDailyTick(store, registry, new Date('2026-11-10T09:00:00Z')), null);
  // The source disappearing or changing country must not reopen a quota.
  state.conversations = state.conversations.filter(c => c.id !== 'hn1');
  state.conversations.find(c => c.id === 'hn2').country = 'PA';
  assert.equal(await runDailyTick(store, registry, new Date('2026-11-10T10:00:00Z')), null);
  state.conversations = [conversation('next1', 'HN', '2026-11-10T16:00:00Z'), conversation('next2', 'PA', '2026-11-10T17:00:00Z')];
  assert.equal((await runDailyTick(store, registry, new Date('2026-11-11T06:01:00Z'))).caseCount, 2);
  await idle(state);
});

test('reducir una cohorte conserva resultados e intentos, difiere solo pendientes y continúa Panamá incluso después de medianoche', async () => {
  const { state, store, registry, calls } = fixture();
  state.conversations = [conversation('old')];
  await runDailyTick(store, registry, new Date('2026-11-10T07:00:00Z')); await idle(state);
  state.conversations.push(...['current1', 'current2', 'excess1', 'excess2'].map(id => conversation(id)));
  const batch = await runDailyTick(store, registry, new Date('2026-11-10T08:00:00Z')); await idle(state);
  // Build a persisted interruption: Clef has a partial result on current1;
  // every other task is untouched. Its valid result must survive resumption.
  const retained = state.tasks.find(t => t.jobId === batch.id && t.conversationId === 'current1' && t.profile.id === 'clef-local');
  for (const task of state.tasks.filter(t => t.jobId === batch.id)) {
    if (task === retained) { task.status = 'partial'; task.error = { code: 'AI_CONTEXT_LIMIT' }; }
    else { task.status = 'pending'; task.evaluationId = null; task.profileStates = {}; task.error = null; }
  }
  state.attempts = state.attempts.filter(a => a.jobId !== batch.id || a.taskId === retained.id);
  state.evaluations = state.evaluations.filter(e => e.jobId !== batch.id || e.taskId === retained.id);
  state.operationalRefs = state.operationalRefs.filter(r => r.id === 'old' || r.id === 'current1');
  const current = state.jobs.find(j => j.id === batch.id);
  Object.assign(current, { status: 'running', completed: 0, failed: 1, partial: 1, updatedAt: '2026-11-10T14:00:00Z' });
  const preserved = structuredClone({ attempts: state.attempts, evaluations: state.evaluations });
  calls.length = 0;
  const request = await prepareDailyLimit(store, { activityDate: '2026-11-09', expectedVersion: 14,
    limitPerCountry: 3, now: new Date('2026-11-10T14:01:00Z') });
  assert.equal(await runDailyTick(store, registry, new Date('2026-11-10T14:02:00Z')), null);
  await assert.rejects(applyDailyLimit(store, { requestId: request.id, expectedVersion: 15, now: new Date('2026-11-10T14:03:00Z') }), { code: 'EVALUATION_RUNNING' });
  const result = await applyDailyLimit(store, { requestId: request.id, expectedVersion: 15, now: new Date('2026-11-10T14:11:00Z') });
  assert.deepEqual(result.selected, { HN: 3, PA: 0 }); assert.deepEqual(result.deferred, { HN: 2, PA: 0 });
  assert.deepEqual(state.attempts, preserved.attempts); assert.deepEqual(state.evaluations, preserved.evaluations);
  assert.equal(state.tasks.filter(t => t.status === 'deferred').length, 4);
  assert.equal(state.settings.dailyTime, '00:01'); assert.equal(state.settings.aiPolicy.mode, 'single');
  assert.equal((await runDailyTick(store, registry, new Date('2026-11-10T14:12:00Z'))).id, batch.id); await idle(state);
  assert.deepEqual(calls.sort(), [['current1', 'gemma-local'], ['current2', 'clef-local'], ['current2', 'gemma-local']].sort());
  const done = state.jobs.find(j => j.id === batch.id);
  assert.equal(done.total, 4); assert.equal(done.completed, 3); assert.equal(done.partial, 1); assert.equal(done.status, 'partial');
  assert.ok(evaluationModelProgress(state, done).every(p => p.total === 2 && p.pending === 0));
  state.conversations.push(conversation('pa1', 'PA'), conversation('pa2', 'PA'));
  const panama = await runDailyTick(store, registry, new Date('2026-11-11T06:01:00Z'));
  assert.equal(panama.dailyActivity.date, '2026-11-09'); assert.deepEqual(panama.conversationIds, ['pa1', 'pa2']); await idle(state);
  assert.equal(await runDailyTick(store, registry, new Date('2026-11-11T06:02:00Z')), null);
  assert.equal(state.settings.dailyCatchupRunDate, undefined);
  const today = await runDailyTick(store, registry, new Date('2026-11-11T06:03:00Z')); await idle(state);
  assert.equal(today.dailyActivity.date, '2026-11-10');
});

test('el ajuste falla sin perder trabajo si ya se superó el cupo y exige la versión y mantenimiento correspondientes', async () => {
  const { state, store, registry } = fixture();
  state.conversations = [conversation('a'), conversation('b')];
  await runDailyTick(store, registry, new Date('2026-11-10T07:00:00Z')); await idle(state);
  const request = await prepareDailyLimit(store, { activityDate: '2026-11-09', expectedVersion: 14, limitPerCountry: 1, now: new Date('2026-11-10T14:00:00Z') });
  const before = structuredClone(state);
  await assert.rejects(applyDailyLimit(store, { requestId: request.id, expectedVersion: 14 }), { code: 'VERSION_CONFLICT' });
  await assert.rejects(applyDailyLimit(store, { requestId: 'wrong', expectedVersion: 15 }), { code: 'EVALUATION_MAINTENANCE' });
  await assert.rejects(applyDailyLimit(store, { requestId: request.id, expectedVersion: 15 }), { code: 'DAILY_LIMIT_ALREADY_EXCEEDED' });
  assert.deepEqual(state, before);
});

test('dos conversaciones avanzan en paralelo sin mezclar las fases de Clef y Gemma', async () => {
  const { state, store, registry, calls } = fixture();
  state.settings.dailyLimitPerCountry = 2; state.settings.dailyConcurrency = 2;
  state.conversations = [conversation('h1'), conversation('h2'), conversation('h3'), conversation('p1', 'PA'), conversation('p2', 'PA'), conversation('p3', 'PA')];
  let active = 0, peak = 0, clefFinished = 0;
  for (const profile of registry.profiles) {
    const original = profile.evaluator.evaluate;
    profile.evaluator.evaluate = async (...args) => {
      if (profile.id === 'gemma-local') assert.equal(clefFinished, 4);
      active++; peak = Math.max(peak, active);
      await wait(10);
      const result = await original(...args);
      active--; if (profile.id === 'clef-local') clefFinished++;
      return result;
    };
  }
  const job = await runDailyTick(store, registry, new Date('2026-11-10T07:00:00Z')); await idle(state);
  assert.equal(job.caseCount, 4); assert.equal(peak, 2);
  assert.equal(calls.length, 8); assert.equal(new Set(calls.map(c => c.join(':'))).size, 8);
});
