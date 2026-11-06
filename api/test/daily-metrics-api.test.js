import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { DemoStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { conversationView } from '../src/domain.js';

test('daily figures are detail-only, use local dates and preserve saved evaluations and reviews', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pulso-daily-api-'));
  const store = await new DemoStore(path.join(directory, 'state.json')).init();
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const id = await store.transaction(state => {
    const conversation = state.conversations.find(c => state.reviews.some(r => r.conversationId === c.id));
    // Synthetic multi-day content: local November 3, even though the UTC date is November 4.
    conversation.messages = [
      { id: 'daily-old-client', actor: 'cliente', text: 'Consulta sintética anterior', timestamp: '2026-10-06T15:00:00Z' },
      { id: 'daily-old-human', actor: 'humano', text: 'Respuesta sintética anterior', timestamp: '2026-10-06T15:10:00Z' },
      { id: 'daily-new-client', actor: 'cliente', text: 'Consulta sintética del día', timestamp: '2026-11-04T05:30:00Z' },
      { id: 'daily-new-human', actor: 'humano', text: 'Respuesta sintética del día', timestamp: '2026-11-04T05:40:00Z' },
      { id: 'daily-pending', actor: 'cliente', text: 'Espera sintética pendiente', timestamp: '2026-11-04T05:45:00Z' },
    ];
    const evaluation = state.evaluations.find(e => e.id === conversation.evaluationId);
    const duration = state.catalog.find(v => v.id === 'min_duracion_conversacion');
    evaluation.catalogVersions.push({ id: duration.id, version: duration.version, active: true });
    evaluation.results.push({ variableId: duration.id, status: 'evaluado', value: 39916.58, evidence: [], reason: 'Resultado histórico sintético que debe conservarse.' });
    return conversation.id;
  });
  const config = { demo: true, origin: 'http://127.0.0.1:3000', sessionHours: 8, secureCookie: false, timezone: 'America/Tegucigalpa' };
  const app = createApp(store, config);
  await request(app).get(`/pulsoAtom/api/conversations/${id}`).expect(401);
  const supervisor = request.agent(app);
  await supervisor.post('/pulsoAtom/api/auth/demo').set('Origin', config.origin).send({ role: 'supervisor' }).expect(200);
  const before = await store.read();
  const original = conversationView(before, before.conversations.find(c => c.id === id), undefined, true);
  const response = await supervisor.get(`/pulsoAtom/api/conversations/${id}`).expect(200);
  const detail = response.body.conversation;
  assert.equal(detail.dailyMetrics.timezone, config.timezone);
  assert.equal(detail.dailyMetrics.defaultDate, '2026-11-03');
  assert.deepEqual(detail.dailyMetrics.days.map(d => d.date), ['2026-11-03', '2026-10-06']);
  const today = detail.dailyMetrics.days[0];
  assert.equal(today.metrics.length, 7);
  assert.equal(today.metrics.find(m => m.id === 'min_duracion_conversacion').result.value, 15);
  assert.equal(today.metrics.find(m => m.id === 'min_silencio_max_humano').result.value, 10);
  assert.equal(today.pendingHumanWait.observedMinutes, 0);
  assert.deepEqual(detail.metrics, original.metrics);
  assert.equal(detail.metrics.find(m => m.id === 'min_duracion_conversacion').result.value, 39916.58);
  assert.deepEqual(detail.variables, original.variables);
  assert.deepEqual(detail.reviews, original.reviews);
  assert.deepEqual(detail.messages, original.messages);
  // Reading another day must not create an evaluation, job, task or human decision.
  const anotherRead = await supervisor.get(`/pulsoAtom/api/conversations/${id}?metricDate=2026-10-06`).expect(200);
  assert.deepEqual(anotherRead.body.conversation, detail);
  for (const endpoint of ['conversations', 'search', 'summary']) {
    const list = await supervisor.get(`/pulsoAtom/api/${endpoint}?from=2026-10-01&to=2026-11-04&pageSize=100`).expect(200);
    const items = list.body.items || list.body.conversations;
    assert.ok(items.length);
    assert.ok(items.every(item => !Object.hasOwn(item, 'dailyMetrics') && !Object.hasOwn(item, 'metrics')));
  }
  const after = await store.read();
  for (const key of ['conversations', 'evaluations', 'reviews', 'jobs', 'tasks', 'attempts', 'verdicts', 'operationalRefs']) {
    assert.deepEqual(after[key], before[key], `${key} must remain unchanged`);
  }
});
