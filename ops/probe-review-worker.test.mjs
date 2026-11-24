import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../api/src/data/seed.js';
import { digest, sourceFingerprint } from '../api/src/evaluation-context.js';
import { freshReviewSelectionHash } from '../api/src/fresh-review-run.js';
import { probeReviewSource } from './probe-review-source.mjs';
import { createWorkerProbeFetch, probeReviewWorker } from './probe-review-worker.mjs';

const privateText = 'PRIVATE_CUSTOMER_TEXT_DO_NOT_LOG';
function fixture() {
  const state = createState(false);
  state.catalog.forEach(variable => { variable.active = variable.id === 'cliente_molesto'; });
  state.settings.automation = { prompts: { mode: 'shared', shared: 'Instrucción configurada', byItem: {} },
    timeoutMs: { 'clef-local': 90000, 'gemma-local': 120000 } };
  state.settings.aiPolicy = { mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local', fallbackId: null, version: 1 };
  state.settings.localModelConfiguration = { profiles: ['clef', 'gemma'].map(name => ({
    id: `${name}-local`, model: name === 'clef' ? 'clef-flash' : 'gemma-4-26b-a4b-it-mlx', toolKey: name,
    enabled: true, responseFormat: 'json_schema', protocol: 'chat' })) };
  const all = ['HN', 'PA', 'CR', 'SV', 'MX', 'NI'].map((country, index) => ({
    id: `private-conversation-${index}`, country, completed: true, activityDate: '2026-11-18',
    activityAt: '2026-11-18T18:00:00.000Z', sourceDocumentId: `private-document-${index}`, sourceDocumentHash: digest(index),
    messages: [{ id: `private-message-${index}`, actor: 'cliente', timestamp: '2026-11-18T18:00:00.000Z', text: privateText }],
  }));
  const cases = all.map(conversation => ({ conversationId: conversation.id, country: conversation.country,
    activityDate: conversation.activityDate, activityAt: conversation.activityAt, currentSourceHash: sourceFingerprint(conversation),
    sourceDocumentId: conversation.sourceDocumentId, sourceDocumentHash: conversation.sourceDocumentHash,
    messageCount: 1, selectionOrigin: 'original94' }));
  const scope = { from: '2026-11-17', to: '2026-11-19', timezone: 'America/Tegucigalpa' };
  const manifest = { schemaVersion: 1, id: 'test-request', scope, cases, caseCount: 6,
    profiles: ['clef-local', 'gemma-local'], expectedNewEvaluations: 12,
    counts: Object.fromEntries(all.map(item => [item.country, 1])), reviewDeadline: '2026-11-25T10:00:00-06:00',
    selectionHash: freshReviewSelectionHash({ scope, cases }), preparatoryOnly: true, authorizedForExecution: false };
  return { manifest, state, source: { conversations: [all[0]] },
    env: { GATEWAY_BASE_URL: 'https://gateway.private.invalid', AGENT_SHARED_TOKEN: 'secret-canary-abc', GATEWAY_PORTAL_KEY: 'portal-pulso' } };
}
function responseFor(request, failGemma = false) {
  const failed = failGemma && request.body.model.startsWith('gemma');
  return Response.json({ ok: !failed, tool_key: request.body.model.startsWith('gemma') ? 'gemma' : 'clef',
    method: request.method, path: request.path, request_uuid: 'request-test', upstream_status_code: failed ? 400 : 200,
    response: failed ? { error: { message: 'Unsupported schema anyOf PRIVATE_CUSTOMER_TEXT_DO_NOT_LOG secret-canary-abc https://private.example/path' } }
      : { model: request.body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results: {
        cliente_molesto: { status: 'evaluado', value: 0, reason: 'No hay señales de molestia.', evidence_message_ids: [] },
      } }) } }] } });
}

test('paired worker runs fresh Clef then Gemma with the same source body hash as isolated Gemma and no production state writes', async () => {
  const f = fixture();
  f.state.jobs = [{ id: 'private-existing-job', status: 'running' }];
  f.state.tasks = [{ id: 'private-existing-task', status: 'completed' }];
  f.state.evaluations = [{ id: 'private-existing-result', results: [] }];
  const before = structuredClone(f.state), calls = [];
  const fetchImpl = async (url, options) => { const request = JSON.parse(options.body); calls.push(request); return responseFor(request); };
  const result = await probeReviewWorker({ ...f, fetchImpl });
  assert.equal(result.completed, true); assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks.map(task => task.status), ['completed', 'completed']);
  assert.deepEqual(calls.map(request => request.body.model), ['clef-flash', 'gemma-4-26b-a4b-it-mlx']);
  const isolated = await probeReviewSource({ ...f, fetchImpl });
  assert.equal(result.requests[1].requestBodyHash, isolated.requestSchema.requestHash);
  assert.deepEqual(result.requests.map(request => request.upstreamStatus), [200, 200]);
  assert.equal(result.databaseChanged, false); assert.equal(result.published, false); assert.equal(result.configurationUnchanged, true);
  assert.deepEqual(f.state, before);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|private-conversation|private-document|private-message|secret-canary|https|private-existing/);
});

test('source guard blocks inference and paired Gemma rejection exposes only technical error', async () => {
  const f = fixture(); let calls = 0;
  const result = await probeReviewWorker({ ...f, fetchImpl: async (url, options) => {
    calls++; return responseFor(JSON.parse(options.body), true);
  } });
  assert.equal(calls, 2); assert.equal(result.completed, false);
  assert.equal(result.tasks.find(task => task.profileId === 'clef-local').completed, true);
  assert.equal(result.tasks.find(task => task.profileId === 'gemma-local').error.code, 'AI_CONFIGURATION');
  assert.equal(result.requests[1].upstreamStatus, 400);
  assert.equal(result.requests[1].technicalError.classification, 'schema-or-grammar-rejection');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|secret-canary|https|private-conversation/);
  f.source.conversations[0].messages[0].text = 'Changed';
  await assert.rejects(probeReviewWorker({ ...f, fetchImpl: async () => { calls++; } }), { code: 'SOURCE_CHANGED' });
  assert.equal(calls, 2);
});

test('network observer hard-limits every worker operation to 32 actual calls', async () => {
  let calls = 0;
  const observer = createWorkerProbeFetch({ fetchImpl: async () => { calls++; return Response.json({ ok: true }); } });
  const options = { method: 'POST', body: JSON.stringify({ method: 'GET', path: '/api/v1/models', body: null }) };
  for (let index = 0; index < 32; index++) await observer.fetchImpl('https://private.invalid', options);
  await assert.rejects(observer.fetchImpl('https://private.invalid', options), /WORKER_PROBE_REQUEST_LIMIT/);
  assert.equal(calls, 32); assert.equal(observer.report().blockedRequests, 1);
});
