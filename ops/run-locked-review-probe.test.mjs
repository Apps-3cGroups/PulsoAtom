import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../api/src/data/seed.js';
import { digest, sourceFingerprint } from '../api/src/evaluation-context.js';
import { freshReviewSelectionHash } from '../api/src/fresh-review-run.js';
import { runLockedReviewProbe, createLockedProbeStore } from './run-locked-review-probe.mjs';

function fixture() {
  const state = createState(false);
  state.catalog.forEach(variable => { variable.active = variable.id === 'cliente_molesto'; });
  state.settings.automation = { prompts: { mode: 'shared', shared: 'Instrucción configurada', byItem: {} }, timeoutMs: { 'clef-local': 90000, 'gemma-local': 120000 } };
  state.settings.aiPolicy = { mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local', fallbackId: null, version: 1 };
  state.settings.localModelConfiguration = { profiles: ['clef', 'gemma'].map(name => ({ id: `${name}-local`,
    model: name === 'clef' ? 'clef-flash' : 'gemma-4-26b-a4b-it-mlx', toolKey: name, enabled: true, responseFormat: 'json_schema', protocol: 'chat' })) };
  const all = ['HN', 'PA', 'CR', 'SV', 'MX', 'NI'].map((country, index) => ({ id: `private-conversation-${index}`, country, completed: true,
    activityDate: '2026-11-18', activityAt: '2026-11-18T18:00:00.000Z', sourceDocumentId: `private-document-${index}`, sourceDocumentHash: digest(index),
    messages: [{ id: `private-message-${index}`, actor: 'cliente', timestamp: '2026-11-18T18:00:00.000Z', text: 'PRIVATE_CUSTOMER_TEXT' }] }));
  const cases = all.map(conversation => ({ conversationId: conversation.id, country: conversation.country, activityDate: conversation.activityDate,
    activityAt: conversation.activityAt, currentSourceHash: sourceFingerprint(conversation), sourceDocumentId: conversation.sourceDocumentId,
    sourceDocumentHash: conversation.sourceDocumentHash, messageCount: 1, selectionOrigin: 'original94' }));
  const scope = { from: '2026-11-17', to: '2026-11-19', timezone: 'America/Tegucigalpa' };
  const manifest = { schemaVersion: 1, id: 'test-request', scope, cases, caseCount: 6, profiles: ['clef-local', 'gemma-local'], expectedNewEvaluations: 12,
    counts: Object.fromEntries(all.map(item => [item.country, 1])), reviewDeadline: '2026-11-25T10:00:00-06:00',
    selectionHash: freshReviewSelectionHash({ scope, cases }), preparatoryOnly: true, authorizedForExecution: false };
  const persisted = structuredClone(state), commits = [];
  const connection = { async execute(sql, [id]) { assert.equal(sql, 'SELECT payload FROM comparison_samples WHERE id = ?');
    return [persisted.comparisons.filter(item => item.id === id).map(payload => ({ payload }))]; } };
  const base = {
    async loadEvaluationWorker(_connection, jobId) {
      const result = structuredClone(persisted);
      for (const key of ['tasks', 'attempts', 'evaluations']) result[key] = result[key].filter(item => item.jobId === jobId);
      return result;
    },
    async readSnapshot(load) { return load(connection); },
    async transaction(fn, keys, load) {
      const draft = await load(connection), result = await fn(draft);
      for (const key of keys) {
        const merged = new Map(persisted[key].map(item => [item.id, item]));
        draft[key].forEach(item => merged.set(item.id, structuredClone(item)));
        persisted[key] = [...merged.values()];
      }
      commits.push(keys); return result;
    },
  };
  let fetchCalls = 0;
  return { state, manifest, base, persisted, commits,
    reader: { async read({ conversationIds }) { assert.deepEqual(conversationIds, [all[0].id]); return { conversations: [structuredClone(all[0])] }; } },
    env: { GATEWAY_BASE_URL: 'https://gateway.private.invalid', AGENT_SHARED_TOKEN: 'secret-canary-abc', GATEWAY_PORTAL_KEY: 'portal-pulso' },
    get fetchCalls() { return fetchCalls; },
    fetchImpl: async (url, options) => { fetchCalls++; const request = JSON.parse(options.body);
      return Response.json({ ok: true, tool_key: request.body.model.startsWith('gemma') ? 'gemma' : 'clef', method: request.method, path: request.path,
        request_uuid: 'test-request', upstream_status_code: 200, response: { model: request.body.model,
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results: { cliente_molesto: {
            status: 'evaluado', value: 0, reason: 'Sin señales de molestia.', evidence_message_ids: [] } } }) } }] } }); },
  };
}

test('locked probe persists exactly one comparison and two fresh tasks through the shared transaction boundary', async () => {
  const f = fixture(), settings = structuredClone(f.persisted.settings);
  const result = await runLockedReviewProbe(f);
  assert.equal(result.completed, true); assert.equal(result.comparisonSaved, true); assert.equal(f.fetchCalls, 2);
  assert.equal(f.persisted.jobs.length, 1); assert.equal(f.persisted.jobs[0].purpose, 'comparison');
  assert.equal(f.persisted.comparisons.length, 1); assert.equal(f.persisted.tasks.length, 2); assert.equal(f.persisted.evaluations.length, 2);
  assert.ok(f.commits.every(keys => keys.includes('comparisons') && !keys.includes('operationalRefs')));
  assert.deepEqual(f.persisted.settings, settings); assert.deepEqual(f.persisted.operationalRefs, []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|private-conversation|private-message|secret-canary|https/);
});

test('persisted production running job blocks all inference and all commits', async () => {
  const f = fixture(); f.persisted.jobs.push({ id: 'foreign-job', status: 'running', updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  const before = structuredClone(f.persisted), result = await runLockedReviewProbe(f);
  assert.equal(result.error.code, 'EVALUATION_RUNNING'); assert.equal(result.comparisonSaved, false);
  assert.equal(f.fetchCalls, 0); assert.equal(f.commits.length, 0); assert.deepEqual(f.persisted, before);
});

test('external scheduler runtime updates during inference do not invalidate frozen comparison inputs', async () => {
  const f = fixture(), fetch = f.fetchImpl;
  const result = await runLockedReviewProbe({ ...f, fetchImpl: async (...args) => {
    f.persisted.settings.automationRuntime = { lastCheckedAt: new Date().toISOString(), checked: f.fetchCalls + 1 };
    f.persisted.settings.automationAlerts = [{ code: 'scheduler-heartbeat' }];
    return fetch(...args);
  } });
  assert.equal(result.completed, true); assert.equal(f.fetchCalls, 2);
  assert.equal(f.persisted.settings.automationRuntime.checked, 2);
  assert.deepEqual(f.persisted.settings.automationAlerts, [{ code: 'scheduler-heartbeat' }]);
});

test('actual prompt changes during inference still invalidate the comparison configuration', async () => {
  const f = fixture(), fetch = f.fetchImpl;
  await assert.rejects(runLockedReviewProbe({ ...f, fetchImpl: async (...args) => {
    f.persisted.settings.automation.prompts.shared = 'A different evaluation criterion';
    return fetch(...args);
  } }), { code: 'REVIEW_CONFIGURATION_CHANGED' });
  assert.equal(f.fetchCalls, 1);
  assert.equal(f.persisted.settings.automation.prompts.shared, 'A different evaluation criterion');
});

test('transaction guard rejects settings or operational-reference mutations without committing', async () => {
  const f = fixture(), store = createLockedProbeStore({ ...f, idempotencyKey: 'test-key' });
  await assert.rejects(store.transaction(state => {
    state.jobs.push({ id: 'new-job', purpose: 'comparison', idempotencyKey: 'test-key', conversationIds: [f.manifest.cases[0].conversationId], total: 2 });
    state.tasks.push(...[1, 2].map(id => ({ id: String(id), jobId: 'new-job', conversationId: f.manifest.cases[0].conversationId, status: 'pending' })));
    state.settings.dailyEnabled = !state.settings.dailyEnabled;
  }), { code: 'REVIEW_SETTINGS_CHANGED' });
  assert.equal(f.commits.length, 0); assert.equal(f.fetchCalls, 0);
});
