import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.js';
import { setTimeout as wait } from 'node:timers/promises';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { runDailyTick } from '../src/daily-scheduler.js';
import { activityOnDate, previousDate, dailyActivityRequest } from '../src/daily-activity.js';
import { configureDailyActivity } from '../src/configure-daily-activity.js';
import { startEvaluationBatch } from '../src/evaluation-service.js';

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
