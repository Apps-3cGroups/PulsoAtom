import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../api/src/data/seed.js';
import { digest, sourceFingerprint } from '../api/src/evaluation-context.js';
import { freshReviewSelectionHash } from '../api/src/fresh-review-run.js';
import { supportsAiVariable } from '../api/src/evaluator.js';
import { parseSourceProbeArguments, readSourceProbe, probeReviewSource } from './probe-review-source.mjs';

const privateText = 'PRIVATE_CUSTOMER_TEXT_DO_NOT_LOG';
function fixture() {
  const state = createState(false);
  state.catalog.forEach(variable => { variable.active = true; });
  state.settings.automation = { prompts: { mode: 'shared', shared: 'Instrucción configurada', byItem: {} },
    timeoutMs: { 'clef-local': 90000, 'gemma-local': 120000 } };
  state.settings.localModelConfiguration = { profiles: [
    { id: 'gemma-local', model: 'gemma-4-26b-a4b-it-mlx', toolKey: 'gemma', enabled: true, responseFormat: 'json_schema', protocol: 'chat' },
  ] };
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

test('source probe reads exactly the fixed HN case and fails source changes before any inference', async () => {
  const f = fixture(), reads = [];
  assert.equal(parseSourceProbeArguments(['--request-id', 'test-request']), 'test-request');
  assert.throws(() => parseSourceProbeArguments(['--request-id', '../other']), { code: 'INVALID_ARGUMENTS' });
  await readSourceProbe({ async read(options) { reads.push(options); return f.source; } }, f.manifest);
  assert.deepEqual(reads, [{ fresh: true, conversationIds: [f.manifest.cases[0].conversationId] }]);
  f.source.conversations[0].messages[0].text = 'Changed';
  let calls = 0;
  await assert.rejects(probeReviewSource({ ...f, fetchImpl: async () => { calls++; } }), { code: 'SOURCE_CHANGED' });
  assert.equal(calls, 0);
});

test('one real source request retains first-eight order and runtime, emits no PII or secret and persists nothing', async () => {
  const f = fixture(), before = structuredClone(f.state); let calls = 0;
  const result = await probeReviewSource({ ...f, fetchImpl: async (url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    assert.equal(request.path, '/v1/chat/completions'); assert.equal(request.timeout_ms, 120000);
    assert.match(request.body.messages[0].content, /Instrucción configurada/);
    assert.match(request.body.messages.at(-1).content, /PRIVATE_CUSTOMER_TEXT_DO_NOT_LOG/);
    return Response.json({ ok: false, tool_key: 'gemma', method: 'POST', path: '/v1/chat/completions', request_uuid: 'test-request',
      upstream_status_code: 400, response: { message: 'Failed schema anyOf maxLength 1000 PRIVATE_CUSTOMER_TEXT_DO_NOT_LOG secret-canary-abc https://private.example/path' } });
  } });
  assert.equal(calls, 1); assert.equal(result.networkCalls, 1); assert.equal(result.transport.upstreamStatus, 400);
  assert.equal(result.transport.technicalError.classification, 'schema-or-grammar-rejection');
  assert.deepEqual(result.requestedVariables, f.state.catalog.filter(variable => variable.active && !variable.retired && supportsAiVariable(variable)).slice(0, 8).map(variable => variable.id));
  assert.equal(result.sourceHash, f.manifest.cases[0].currentSourceHash); assert.equal(result.messageCount, 1);
  assert.equal(result.sourceVerified, true); assert.equal(result.databaseChanged, false); assert.equal(result.published, false);
  assert.equal(result.synthetic, false); assert.equal(result.error.code, 'AI_CONFIGURATION');
  assert.deepEqual(f.state, before);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|private-conversation|private-document|private-message|secret-canary|https|quote|promptText/);
});

test('a numbered-model discovery attempt is recorded but never sends a second network call', async () => {
  const f = fixture(); let calls = 0;
  const result = await probeReviewSource({ ...f, fetchImpl: async () => {
    calls++;
    return Response.json({ ok: true, tool_key: 'gemma', method: 'POST', path: '/v1/chat/completions', request_uuid: 'test-request',
      upstream_status_code: 200, response: { model: 'gemma-4-26b-a4b-it-mlx:2', choices: [] } });
  } });
  assert.equal(calls, 1); assert.equal(result.transport.returnedModel, 'gemma-4-26b-a4b-it-mlx:2');
  assert.deepEqual(result.blockedAdditionalOperations, ['GET /api/v1/models']); assert.equal(result.completed, false);
});
