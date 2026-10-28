import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { scheduleClock, runDailyTick } from '../src/daily-scheduler.js';

test('el horario respeta la zona America/Tegucigalpa', () => {
  assert.deepEqual(scheduleClock(new Date('2026-10-27T12:59:00Z'), 'America/Tegucigalpa'), { date: '2026-10-27', time: '06:59' });
  assert.deepEqual(scheduleClock(new Date('2026-10-27T13:00:00Z'), 'America/Tegucigalpa'), { date: '2026-10-27', time: '07:00' });
});

test('la evaluación diaria selecciona solo altas nuevas pendientes y se ejecuta una vez por fecha', async () => {
  const state = createState(false);
  state.settings = { ...state.settings, dailyEnabled: true, dailyStartedAt: '2026-10-27T00:00:00.000Z' };
  const message = { id: 'm1', actor: 'cliente', text: 'Hola' };
  state.conversations = [
    { id: 'old', date: '2026-10-26', completed: true, sourceCreatedAt: '2026-10-26T10:00:00.000Z', sourceUpdatedAt: '2026-10-26T10:00:00.000Z', messages: [message] },
    { id: 'new', date: '2026-10-27', completed: true, sourceCreatedAt: '2026-10-27T10:00:00.000Z', sourceUpdatedAt: '2026-10-27T10:00:00.000Z', messages: [message] },
  ];
  const store = { async read() { return structuredClone(state); }, async readWithConversations() { return structuredClone(state); }, async transaction(fn) { return fn(state); } };
  const evaluator = { configured: true, async evaluate(_conversation, variables) {
    return { model: 'mock', responseId: 'mock-1', results: variables.map(v => ({ variableId: v.id, status: 'evaluado', value: 0, reason: 'Prueba.', evidence: [] })) };
  } };
  assert.equal(await runDailyTick(store, evaluator, new Date('2026-10-27T12:59:00Z')), null);
  const job = await runDailyTick(store, evaluator, new Date('2026-10-27T13:00:00Z'));
  assert.deepEqual(job.conversationIds, ['new']);
  assert.equal(job.scope, 'daily');
  assert.equal(await runDailyTick(store, evaluator, new Date('2026-10-27T14:00:00Z')), null);
  for (let attempt = 0; attempt < 20 && state.jobs[0].status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(state.jobs[0].status, 'completed');
  assert.deepEqual(state.evaluations.map(e => e.conversationId), ['new']);
});
