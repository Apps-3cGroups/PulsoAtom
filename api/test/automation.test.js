import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { AppError } from '../src/errors.js';
import { automationConfiguration, saveAutomationConfiguration, runtimeConfiguration, fingerprint } from '../src/automation-configuration.js';
import { runAutomationTick, startAutomationWorker, automationClock } from '../src/automation-scheduler.js';
import { startEvaluationBatch, resumeEvaluationBatch } from '../src/evaluation-service.js';
import { operationalEvaluation } from '../src/operational-evaluation.js';
import { selectAutomationCandidates, zonedDayBounds } from '../src/automation-source.js';
import { previousDate, activityOnDate } from '../src/daily-activity.js';
import { automationMonitor } from '../src/automation-routes.js';

const modelIds = ['clef-local', 'gemma-local'];
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(handler) {
  let state = createState(false);
  state.catalog = state.catalog.filter(v => v.active && v.type === 'Flag' && v.method === 'IA').slice(0, 2);
  state.catalogVersions = state.catalogVersions.filter(v => state.catalog.some(c => c.id === v.itemId));
  const date = new Date();
  const activityDate = previousDate(automationClock(date, 'America/Tegucigalpa').date);
  const countries = [{ code: 'HN', name: 'Honduras' }, { code: 'PA', name: 'Panamá' }, { code: 'CR', name: 'Costa Rica' }];
  state.countries = countries;
  state.conversations = countries.flatMap(country => Array.from({ length: 4 }, (_, i) => ({ id: `${country.code}-${i}`, country: country.code, date: activityDate,
    completed: i % 2 === 0, lastActivityAt: `${activityDate}T12:00:00Z`, sourceUpdatedAt: `${activityDate}T12:00:00Z`,
    messages: [{ id: `${country.code}-${i}-msg`, actor: 'cliente', text: 'Consulta sintética de prueba.', timestamp: `${activityDate}T12:00:00Z` }] })));
  const calls = [];
  const evaluator = (id, runtime) => ({ configured: true, withRuntime: runtime => evaluator(id, runtime), instructionsText: runtime?.promptText,
    async evaluate(conversation, variables) {
      const call = { id, conversationId: conversation.id, prompt: runtime?.promptText, itemPrompts: runtime?.itemPrompts, text: conversation.messages[0].text }; calls.push(call);
      if (handler) await handler(call, state);
      return { model: registry.profiles.find(p => p.id === id).model, results: variables.map(v => ({ variableId: v.id, type: v.type, method: v.method, status: 'evaluado', value: 1, reason: 'Evidencia sintética.', evidence: [{ messageId: conversation.messages[0].id, quote: conversation.messages[0].text }] })) };
    } });
  const registry = new ModelRegistry(modelIds.map(id => ({ id, label: id, model: id, provider: 'demo', enabled: true, evaluator: evaluator(id) })));
  state.settings.automation = { ...automationConfiguration(state.settings, countries, registry), enabled: true, time: '00:00', executionOrder: 'parallel',
    countries: countries.map(c => ({ ...c, enabled: c.code !== 'CR', paused: false, dailyLimit: c.code === 'HN' ? 2 : 1 })) };
  state.settings.dailyEnabled = true;
  let queue = Promise.resolve();
  const store = {
    async read() { await queue; return structuredClone(state); },
    async readWithConversations({ conversationIds } = {}) { const s = await this.read(); if (conversationIds) s.conversations = s.conversations.filter(c => conversationIds.includes(c.id)); return s; },
    async readCountryCatalog() { return countries; },
    async readAutomationSource({ date, timezone }) { const s = await this.read(); return { countries, conversations: s.conversations.filter(c => activityOnDate(c, date, timezone)), loads: countries.map(c => ({ country: c.code, loadedAt: new Date().toISOString() })) }; },
    async transaction(fn) { const run = queue.then(async () => { const draft = structuredClone(state); const result = await fn(draft); state = draft; return structuredClone(result); }); queue = run.catch(() => {}); return run; },
  };
  const tick = async (offset = 0) => { const execution = await runAutomationTick(store, registry, new Date(date.getTime() + offset)); if (execution) await execution.completion; return execution; };
  return { store, registry, calls, date, activityDate, countries, tick };
}

test('daily country quotas reserve unique conversations, share model membership, and leave all source data visible', async () => {
  const f = fixture(); await f.tick();
  const state = await f.store.read();
  assert.equal(state.conversations.length, 12);
  assert.equal(state.dailyAssignments.length, 3);
  assert.equal(state.dailyAssignments.filter(a => a.country === 'HN').length, 2);
  assert.equal(state.dailyAssignments.filter(a => a.country === 'PA').length, 1);
  assert.equal(state.evaluations.length, 6);
  for (const a of state.dailyAssignments) assert.equal(f.calls.filter(c => c.conversationId === a.conversationId).length, 2);
  await f.tick(61000); assert.equal(f.calls.length, 6);
  const report = automationMonitor(await f.store.read(), f.activityDate);
  assert.equal(report.countries.find(c => c.code === 'HN').outsideSample, 2);
  assert.equal(report.countries.find(c => c.code === 'CR').selected, 0);
});

test('late imports fill only remaining slots and lowering quota never releases existing assignments', async () => {
  const f = fixture();
  await f.store.transaction(s => { s.conversations = s.conversations.filter(c => c.id.endsWith('-0')); });
  await f.tick();
  await f.store.transaction(s => { const first = s.conversations[0]; s.conversations.push({ ...first, id: 'HN-late' }); });
  await f.tick(61000);
  assert.equal((await f.store.read()).dailyAssignments.length, 3);
  await f.store.transaction(s => { s.settings.automation.countries[0].dailyLimit = 1; s.settings.version++; });
  await f.tick(122000);
  assert.equal((await f.store.read()).dailyAssignments.filter(a => a.country === 'HN').length, 2);
  assert.equal(f.calls.length, 6);
});

test('two concurrent detections cannot double reserve quota or launch two workers', async () => {
  const f = fixture();
  const results = await Promise.all([runAutomationTick(f.store, f.registry, f.date), runAutomationTick(f.store, f.registry, f.date)]);
  await Promise.all(results.filter(Boolean).map(r => r.completion));
  assert.equal((await f.store.read()).dailyAssignments.length, 3);
  assert.equal(f.calls.length, 6);
});

test('parallel mode overlaps both models, with one in-flight request per model', async () => {
  const hold = gate(), started = gate(); let active = 0, peak = 0;
  const f = fixture(async () => { active++; peak = Math.max(peak, active); if (active === 2) started.resolve(); await hold.promise; active--; });
  const execution = await runAutomationTick(f.store, f.registry, f.date);
  await started.promise; assert.equal(peak, 2); hold.resolve(); await execution.completion;
  assert.equal(f.calls.length, 6);
});

test('model-first barrier spans technical blocks and conversation-first preserves each model order', async () => {
  for (const mode of ['model-first', 'conversation-first']) {
    const f = fixture();
    await f.store.transaction(s => { s.settings.automation.executionOrder = mode; s.settings.automation.blockSize = 1; s.settings.automation.modelOrder = [...modelIds].reverse(); });
    for (let i = 0; i < 7; i++) await f.tick(i * 1000);
    if (mode === 'model-first') assert.deepEqual(f.calls.map(c => c.id), [...Array(3).fill('gemma-local'), ...Array(3).fill('clef-local')]);
    else for (let i = 0; i < 6; i += 2) { assert.equal(f.calls[i].id, 'gemma-local'); assert.equal(f.calls[i + 1].id, 'clef-local'); assert.equal(f.calls[i].conversationId, f.calls[i + 1].conversationId); }
  }
});

test('bounded durable retries retain successes and recover selected work after a date change', async () => {
  const f = fixture(async call => { if (call.id === 'gemma-local') throw new AppError(502, 'No disponible', 'AI_UNAVAILABLE'); });
  await f.tick();
  assert.equal(f.calls.filter(c => c.id === 'clef-local').length, 3);
  await f.tick(31000); await f.tick(152000); await f.tick(86400000);
  const s = await f.store.read();
  assert.equal(s.tasks.filter(t => t.status === 'failed').length, 3);
  assert.equal(f.calls.filter(c => c.id === 'clef-local').length, 3);
  assert.equal(s.dailyAssignments.length, 3);
  const original = s.dailyAssignments.filter(a => a.activityDate === f.activityDate);
  assert.equal(original.length, 3);
  for (const a of original) {
    const job = s.jobs.find(j => j.id === a.jobId);
    assert.equal(s.tasks.find(t => t.jobId === job.id && t.conversationId === a.conversationId && t.profile.id === 'gemma-local').automaticAttempts, 3);
  }
});

test('country pause keeps pending work and resumes without repeating a successful model', async () => {
  const f = fixture(async call => { if (call.id === 'clef-local') await f.store.transaction(s => { s.settings.automation.countries.find(c => c.code === call.conversationId.slice(0, 2)).paused = true; }); });
  await f.store.transaction(s => { s.settings.automation.executionOrder = 'conversation-first'; });
  await f.tick();
  const first = f.calls.length;
  assert.ok(first > 0); assert.equal(f.calls.some(c => c.id === 'gemma-local'), false);
  await f.tick(1000); assert.equal(f.calls.length, first);
  await f.store.transaction(s => { for (const c of s.settings.automation.countries) c.paused = false; });
  await f.tick(2000);
  assert.ok(f.calls.some(c => c.id === 'gemma-local'));
});

test('queued prompts and catalog remain frozen after configuration edits; different model prompts retain consensus', async () => {
  const f = fixture();
  await f.store.transaction(s => { s.settings.automation.prompts.mode = 'per-model'; s.settings.automation.prompts.byModel = { 'clef-local': 'Prompt Clef original', 'gemma-local': 'Prompt Gemma original' }; });
  const state = await f.store.read(), configuration = state.settings.automation;
  const { job } = await startEvaluationBatch(f.store, f.registry, { conversationIds: ['HN-0'], max: 1, pendingOnly: false, includeOpen: true,
    modelIds, executionOrder: 'parallel', runtimeConfiguration: runtimeConfiguration(configuration),
    automation: { activityDate: f.activityDate, configurationVersion: state.settings.version, configuration } });
  await f.store.transaction(s => { const next = structuredClone(configuration); next.prompts.byModel['clef-local'] = 'Prompt nuevo'; saveAutomationConfiguration(s, { expectedVersion: s.settings.version, automation: next }, { id: 'admin', name: 'Admin' }, f.countries, f.registry); });
  const execution = await startAutomationWorker(f.store, f.registry, job.id, f.date); await execution.completion;
  assert.deepEqual(f.calls.map(c => c.prompt).sort(), ['Prompt Clef original', 'Prompt Gemma original']);
  const saved = await f.store.read();
  assert.equal(new Set(saved.evaluations.map(e => e.modelPromptHash)).size, 2);
  const anchor = saved.evaluations.find(e => e.id === saved.operationalRefs[0].evaluationId);
  const result = operationalEvaluation(saved, anchor);
  assert.ok(result.dual); assert.ok(result.results.some(r => r.comparison?.agreement === 'agree-positive'));
  saved.evaluations.find(e => e.profileId === 'gemma-local').modelPromptHash = 'otra-version';
  const incompatible = operationalEvaluation(saved, anchor);
  assert.ok(!incompatible.results.some(r => r.comparison?.agreement === 'agree-positive'));
});

test('changed source prepares both models on a new revision without consuming another daily slot', async () => {
  let changed = false;
  const f = fixture(async call => { if (!changed) { changed = true; await f.store.transaction(s => { s.conversations.find(c => c.id === call.conversationId).messages[0].text = 'Contenido actualizado.'; }); } });
  await f.store.transaction(s => { s.settings.automation.countries.forEach(c => { c.enabled = c.code === 'HN'; c.dailyLimit = 1; }); });
  await f.tick(); await f.tick(1000);
  const state = await f.store.read();
  assert.equal(state.dailyAssignments.length, 1);
  assert.equal(state.dailyAssignments[0].jobIds.length, 2);
  const currentId = state.dailyAssignments[0].jobId;
  assert.equal(state.tasks.filter(t => t.jobId === currentId && t.status === 'completed').length, 2);
});

test('manual evaluations are independent of disabled countries and exhausted daily quota', async () => {
  const f = fixture(); await f.tick();
  const { completion } = await startEvaluationBatch(f.store, f.registry, { modelIds, conversationIds: ['CR-0'], max: 1, pendingOnly: false });
  await completion;
  assert.equal((await f.store.read()).dailyAssignments.length, 3);
  assert.equal(f.calls.filter(c => c.conversationId === 'CR-0').length, 2);
});

test('sampling is reproducible regardless of import order and timezone bounds handle daylight saving', () => {
  const config = { countries: [{ code: 'HN', enabled: true, paused: false, dailyLimit: 3 }], selection: 'random', includeOpen: true };
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i), country: 'HN' }));
  assert.deepEqual(selectAutomationCandidates(rows, [], config, '2026-11-15'), selectAutomationCandidates([...rows].reverse(), [], config, '2026-11-15'));
  const hn = zonedDayBounds('2026-11-15', 'America/Tegucigalpa');
  assert.equal(hn.start.toISOString(), '2026-11-15T06:00:00.000Z');
  const dst = zonedDayBounds('2026-03-08', 'America/New_York');
  assert.equal(dst.end - dst.start, 23 * 3600000);
});

test('version conflicts are atomic and invalid country limits are rejected', async () => {
  const f = fixture();
  const state = await f.store.read();
  await assert.rejects(f.store.transaction(s => saveAutomationConfiguration(s, { expectedVersion: 999, automation: s.settings.automation }, { id: 'x', name: 'X' }, f.countries)), { code: 'VERSION_CONFLICT' });
  await assert.rejects(f.store.transaction(s => { const next = structuredClone(s.settings.automation); next.countries[0].dailyLimit = 0; saveAutomationConfiguration(s, { expectedVersion: s.settings.version, automation: next }, { name: 'X' }, f.countries); }));
  assert.deepEqual((await f.store.read()).settings, state.settings);
});

test('per-item prompts resolve independently, survive JSON key reordering and stay frozen during retries', async () => {
  let fail = true;
  const f = fixture(call => { if (call.id === 'gemma-local' && fail) throw new AppError(502, 'Reintentar', 'AI_UNAVAILABLE'); });
  await f.store.transaction(s => {
    const [first, second] = s.catalog;
    s.settings.automation.prompts.byItem = {
      [first.id]: { mode: 'per-model', shared: '', byModel: { 'clef-local': 'Criterio Clef original', 'gemma-local': 'Criterio Gemma original' } },
      [second.id]: { mode: 'shared', shared: 'Criterio compartido original', byModel: { 'clef-local': '', 'gemma-local': '' } },
    };
  });
  const before = await f.store.read(), [first, second] = before.catalog;
  await f.tick();
  await f.store.transaction(s => {
    const next = structuredClone(s.settings.automation);
    next.prompts.byItem[first.id].byModel['gemma-local'] = 'Nueva instrucción';
    saveAutomationConfiguration(s, { expectedVersion: s.settings.version, automation: next }, { id: 'admin', name: 'Admin' }, f.countries);
  });
  fail = false; await f.tick(31000);
  assert.ok(f.calls.filter(c => c.id === 'gemma-local').every(c => c.itemPrompts[first.id] === 'Criterio Gemma original'));
  assert.ok(f.calls.every(c => c.itemPrompts[second.id] === 'Criterio compartido original'));
  const saved = await f.store.read();
  assert.equal(saved.evaluations.length, 6);
  assert.ok(saved.jobs.every(j => j.promptSnapshot.profiles['gemma-local'].itemPrompts[first.id] === 'Criterio Gemma original'));
  assert.equal(fingerprint({ a: { z: 1, x: 2 }, b: 3 }), fingerprint({ b: 3, a: { x: 2, z: 1 } }));
  const next = structuredClone(saved.settings.automation);
  next.prompts.byItem.unknown_item = { mode: 'shared', shared: 'Incorrecto' };
  await assert.rejects(f.store.transaction(s => saveAutomationConfiguration(s, { expectedVersion: s.settings.version, automation: next }, { name: 'Admin' }, f.countries)), { code: 'INVALID_PROMPT_ITEM' });
});

test('expired worker leases fence late responses and recovery retains a single saved result', async () => {
  const hold = gate(), started = gate(); let first = true;
  const f = fixture(async () => { if (first) { first = false; started.resolve(); await hold.promise; } });
  await f.store.transaction(s => { s.settings.automation.executionOrder = 'conversation-first'; });
  const old = await runAutomationTick(f.store, f.registry, f.date);
  await started.promise;
  await f.store.transaction(s => { s.jobs[0].updatedAt = new Date(Date.now() - 11 * 60000).toISOString(); });
  const replacement = await runAutomationTick(f.store, f.registry, f.date);
  await replacement.completion;
  hold.resolve(); await assert.rejects(old.completion, { code: 'WORKER_REPLACED' });
  const state = await f.store.read();
  assert.equal(state.evaluations.length, 6);
  assert.equal(new Set(state.evaluations.map(e => e.taskId)).size, 6);
  assert.equal(state.dailyAssignments.length, 3);
});

test('missing catalog snapshots leave an actionable failure instead of stranding a running job', async () => {
  const f = fixture();
  const s = await f.store.read(), configuration = s.settings.automation;
  const { job } = await startEvaluationBatch(f.store, f.registry, { conversationIds: ['HN-0'], max: 1, pendingOnly: false,
    modelIds, runtimeConfiguration: runtimeConfiguration(configuration), automation: { activityDate: f.activityDate, configurationVersion: s.settings.version, configuration } });
  await f.store.transaction(state => { state.catalogVersions = []; });
  const worker = await startAutomationWorker(f.store, f.registry, job.id, f.date);
  await assert.rejects(worker.completion, { code: 'MISSING_CATALOG_VERSION' });
  const after = await f.store.read();
  assert.equal(after.jobs[0].status, 'failed');
  assert.equal(after.tasks.every(t => t.error.code === 'MISSING_CATALOG_VERSION'), true);
  assert.equal(f.calls.length, 0);
});

test('a later document revision refreshes a completed selection without spending quota twice', async () => {
  const f = fixture(); await f.tick();
  const initial = await f.store.read(), assignment = initial.dailyAssignments[0];
  await f.store.transaction(s => {
    const c = s.conversations.find(c => c.id === assignment.conversationId);
    c.messages[0].text = 'Nueva información del cliente.'; c.sourceUpdatedAt = new Date().toISOString();
  });
  await f.tick(61000);
  const after = await f.store.read();
  assert.equal(after.dailyAssignments.length, 3);
  const current = after.dailyAssignments.find(a => a.id === assignment.id);
  assert.equal(current.jobIds.length, 2);
  assert.equal(after.evaluations.filter(e => e.jobId === current.jobId).length, 2);
});

test('sequential modes exhaust the first model attempts before allowing the second model', async () => {
  for (const mode of ['model-first', 'conversation-first']) {
    const f = fixture(call => { if (call.id === 'clef-local') throw new AppError(502, 'Modelo caído', 'AI_UNAVAILABLE'); });
    await f.store.transaction(s => { s.settings.automation.executionOrder = mode; });
    await f.tick(); await f.tick(1000); await f.tick(31000);
    assert.equal(f.calls.some(c => c.id === 'gemma-local'), false);
    await f.tick(152000); await f.tick(153000);
    assert.equal(f.calls.filter(c => c.id === 'gemma-local').length, 3);
    assert.equal((await f.store.read()).settings.automationRuntime.alerts.filter(a => a.type === 'retries_exhausted').length, 3);
  }
});

test('transition adopts selected legacy daily failures while retaining their successful model', async () => {
  let unavailable = true;
  const f = fixture(call => { if (call.id === 'gemma-local' && unavailable) throw new AppError(502, 'No disponible', 'AI_UNAVAILABLE'); });
  const config = (await f.store.read()).settings.automation;
  config.countries.forEach(c => { c.enabled = c.code === 'HN'; c.dailyLimit = 1; });
  await f.store.transaction(s => { delete s.settings.automation; });
  const initial = await startEvaluationBatch(f.store, f.registry, { conversationIds: ['HN-0'], modelIds, max: 1, pendingOnly: false });
  await initial.completion;
  await f.store.transaction(s => {
    const j = s.jobs.find(j => j.id === initial.job.id);
    j.dailyActivity = { date: f.activityDate, timezone: 'America/Tegucigalpa' }; j.conversationCountries = { 'HN-0': 'HN' };
    s.settings.automation = config;
  });
  unavailable = false; await f.tick();
  const state = await f.store.read();
  assert.equal(state.dailyAssignments.length, 1);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].automation.legacy, true);
  assert.equal(state.jobs[0].status, 'completed');
  assert.equal(f.calls.filter(c => c.id === 'clef-local').length, 1);
});

test('explicit resume after changing a model connection creates a compatible pair without a new quota', async () => {
  let fail = true;
  const f = fixture(call => { if (call.id === 'gemma-local' && fail) throw new AppError(409, 'Configuración inválida', 'AI_CONFIGURATION'); });
  await f.store.transaction(s => { s.settings.automation.countries.forEach(c => { c.enabled = c.code === 'HN'; c.dailyLimit = 1; }); });
  await f.tick();
  const before = await f.store.read(), jobId = before.dailyAssignments[0].jobId;
  // Simulate an administrative connection edit after the previous task stopped.
  f.registry.profiles.find(p => p.id === 'gemma-local').model = 'gemma-local-v2';
  fail = false;
  await resumeEvaluationBatch(f.store, f.registry, jobId);
  await f.tick(1000);
  const after = await f.store.read();
  assert.equal(after.dailyAssignments.length, 1);
  assert.equal(after.dailyAssignments[0].jobIds.length, 2);
  assert.equal(after.tasks.filter(t => t.jobId === after.dailyAssignments[0].jobId && t.status === 'completed').length, 2);
});

test('empty availability avoids empty jobs and deduplicates distinct no-load and no-eligible alerts', async () => {
  const f = fixture();
  await f.store.transaction(s => { s.conversations = []; s.settings.automation.missingLoadMinutes = 1; });
  f.store.readAutomationSource = async () => ({ countries: f.countries, conversations: [], loads: [{ country: 'HN' }] });
  await f.tick(2 * 60000); await f.tick(3 * 60000);
  const s = await f.store.read();
  assert.equal(s.jobs.length, 0);
  assert.equal(s.settings.automationRuntime.alerts.filter(a => a.type === 'no_eligible').length, 1);
  assert.equal(s.settings.automationRuntime.alerts.filter(a => a.type === 'missing_load').length, 1);
});
