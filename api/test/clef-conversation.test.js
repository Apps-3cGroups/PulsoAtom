import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runClefConversationCheck, readProbeState } from '../scripts/check-clef-conversation.js';
import { evaluationContext } from '../src/evaluation-context.js';

const env = { GATEWAY_BASE_URL: 'http://gateway.synthetic', AGENT_SHARED_TOKEN: 'private-synthetic-token' };
const requestUuid = '00000000-1111-4222-8333-444444444444';
function data() {
  const conversation = { id: '123', country: 'HN', completed: true, messages: [
    { id: 'm1', actor: 'cliente', text: 'SYNTHETIC_PRIVATE_TRANSCRIPT felicito al asistente', timestamp: '2026-11-07T10:00:00Z' },
    { id: 'm2', actor: 'humano', text: 'SYNTHETIC_PRIVATE_GOODBYE', timestamp: '2026-11-07T10:01:00Z' },
  ] };
  const catalog = [
    { id: 'cliente_felicito_al_asistente', version: 1, active: true, type: 'Flag', method: 'IA', definition: 'Felicitación explícita.' },
    { id: 'asistente_no_respondio_ultimo_mensaje', version: 1, active: true, type: 'Flag', method: 'IA + código', definition: 'Falta de respuesta.' },
  ];
  const state = { catalog, settings: { dailyEnabled: false, aiPolicy: { mode: 'single', primaryId: 'gemma-local', version: 6 } },
    activity: { jobs: 0, tasks: 0, attempts: 0 }, reference: { id: 'gemma-evaluation', conversationId: '123', ...evaluationContext(conversation, catalog) } };
  const raw = { results: Object.fromEntries(catalog.map(v => [v.id, { status: 'evaluado', value: 1, reason: 'RAZON_PRIVADA', evidence_message_ids: ['m1'] }])) };
  return { conversation, state, raw };
}
async function fixture(t, change) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clef-probe-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, 'probe.json');
  const { conversation, state, raw } = data();
  const calls = [], reads = [], snapshots = [];
  const args = { outputPath, env, readState: async (_connection, options) => { snapshots.push(options); return structuredClone(state); },
    reader: { read: async options => { reads.push(options); return { conversations: [structuredClone(conversation)] }; } },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      const envelope = { ok: true, tool_key: 'gemma', method: 'POST', path: '/v1/chat/completions', upstream_status_code: 200, request_uuid: requestUuid,
        response: { model: 'clef-flash', usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] } };
      change?.({ raw, envelope, state, conversation });
      return new Response(JSON.stringify(envelope), { status: 200 });
    } };
  return { args, calls, reads, snapshots, outputPath, state, conversation };
}

test('one real-content-shaped probe is isolated, strips quotes and is idempotent without re-inference', async t => {
  const fixtureData = await fixture(t), { args, calls, reads, snapshots, outputPath, state } = fixtureData;
  const before = structuredClone(state);
  const summary = await runClefConversationCheck(args);
  assert.equal(summary.success, true);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.gemmaComparable, true);
  assert.equal(summary.protocol.responseShape.content.type, 'string');
  assert.equal(summary.protocol.responseShape.contentHasResults, true);
  assert.equal(summary.protocol.responseShape.reasoningContent.type, 'missing');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'clef-flash');
  assert.equal(calls[0].body.max_tokens, 16000);
  assert.equal(calls[0].timeout_ms, 180000);
  assert.deepEqual(reads, [{ fresh: true, conversationIds: ['123'] }, { fresh: true, conversationIds: ['123'] }]);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(state, before);
  const serialized = await readFile(outputPath, 'utf8'), artifact = JSON.parse(serialized);
  assert.ok(!serialized.includes('SYNTHETIC_PRIVATE_TRANSCRIPT'));
  assert.ok(!serialized.includes('SYNTHETIC_PRIVATE_GOODBYE'));
  assert.ok(!serialized.includes('"quote"'));
  assert.ok(serialized.includes('RAZON_PRIVADA'));
  assert.ok(!JSON.stringify(summary).includes('RAZON_PRIVADA'));
  assert.deepEqual(artifact.results[1].aiResult.evidenceMessageIds, ['m1']);
  assert.equal(artifact.results[1].value, 0);
  assert.equal(artifact.results[1].aiResult.value, 1);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  const second = await runClefConversationCheck(args);
  assert.equal(second.reused, true);
  assert.equal(calls.length, 1);
  assert.equal(reads.length, 2);
});

test('invalid output remains a failed single attempt with protocol metadata and no raw response', async t => {
  const { args, calls, outputPath } = await fixture(t, ({ envelope }) => { envelope.response.choices[0].message.content = 'UNSAFE_RAW_RESPONSE'; });
  const summary = await runClefConversationCheck(args);
  assert.equal(summary.success, false);
  assert.equal(summary.errorCode, 'INVALID_AI_RESULT');
  assert.equal(summary.protocol.finishReason, 'stop');
  assert.equal(summary.protocol.outputCharacters, 19);
  assert.equal(summary.protocol.usage.total_tokens, 15);
  assert.equal(summary.protocol.responseShape.content.type, 'string');
  assert.equal(summary.protocol.responseShape.contentIsJsonObject, false);
  assert.equal(summary.pendingVariables, 2);
  assert.equal(calls.length, 1);
  assert.ok(!(await readFile(outputPath, 'utf8')).includes('UNSAFE_RAW_RESPONSE'));
});

test('reasoning-only replies retain structural diagnostics without exposing reasoning or treating it as results', async t => {
  const { args, calls, outputPath } = await fixture(t, ({ envelope }) => {
    envelope.response.choices[0].message.content = null;
    envelope.response.choices[0].message.reasoning_content = '{"results":{"PRIVATE_REASONING":"SECRET_DIAGNOSTIC_TEXT"}}';
  });
  const summary = await runClefConversationCheck(args);
  assert.equal(summary.success, false);
  assert.equal(summary.validVariables, 0);
  assert.equal(summary.errorCode, 'INVALID_AI_RESULT');
  assert.equal(summary.protocol.responseShape.content.type, 'null');
  assert.equal(summary.protocol.responseShape.reasoningContent.type, 'string');
  assert.equal(summary.protocol.responseShape.reasoningHasResults, true);
  assert.equal(calls.length, 1);
  for (const text of [JSON.stringify(summary), await readFile(outputPath, 'utf8')]) {
    assert.ok(!text.includes('PRIVATE_REASONING'));
    assert.ok(!text.includes('SECRET_DIAGNOSTIC_TEXT'));
  }
});

test('partial output retains per-variable validation errors; changed source prevents a successful check', async t => {
  const partial = await fixture(t, ({ envelope, raw }) => {
    raw.results.asistente_no_respondio_ultimo_mensaje.reason = '';
    envelope.response.choices[0].message.content = JSON.stringify(raw);
  });
  const summary = await runClefConversationCheck(partial.args);
  assert.equal(summary.status, 'partial');
  assert.equal(summary.validVariables, 1);
  assert.deepEqual(summary.validationErrors, [{ variableId: 'asistente_no_respondio_ultimo_mensaje', rules: ['invalid_reason'], code: 'INVALID_AI_RESULT' }]);
  const changed = await fixture(t, ({ conversation }) => { conversation.messages[0].text = 'changed after inference'; });
  const changedSummary = await runClefConversationCheck(changed.args);
  assert.equal(changedSummary.status, 'changed');
  assert.equal(changedSummary.success, false);
  assert.equal(changedSummary.sourceUnchanged, false);
  assert.equal(changed.calls.length, 1);
});

test('active evaluations or a reserved probe prevent any inference', async t => {
  const active = await fixture(t); active.state.activity.jobs = 1;
  assert.equal((await runClefConversationCheck(active.args)).errorCode, 'EVALUATION_RUNNING');
  assert.equal(active.calls.length, 0);
  assert.equal(active.reads.length, 0);
  const reserved = await fixture(t);
  await writeFile(`${reserved.outputPath}.lock`, 'reserved', { mode: 0o600 });
  await assert.rejects(runClefConversationCheck(reserved.args), error => error.code === 'EEXIST');
  assert.equal(reserved.snapshots.length, 0);
  assert.equal(reserved.calls.length, 0);
});

test('database selection uses only read-only transaction and SELECT for the exact maintenance', async () => {
  const { state } = data(), statements = [];
  const connection = {
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith('START')) return [];
      if (sql.includes('catalog_items')) return [state.catalog.map(payload => ({ payload }))];
      if (sql.includes('portal_settings')) return [[{ payload: state.settings }]];
      return [[state.activity]];
    },
    async execute(sql, parameters) {
      statements.push(sql);
      assert.deepEqual(parameters, ['77f134e8-fdf8-4154-b1f6-485c159b9194']);
      assert.match(sql, /LIMIT 1/);
      assert.match(sql, /'completed'/);
      return [[{ payload: state.reference }]];
    }, async commit() {}, async rollback() { assert.fail('Unexpected rollback'); },
  };
  const selected = await readProbeState(connection, { chooseReference: true });
  assert.equal(selected.reference.conversationId, '123');
  assert.equal(statements[0], 'START TRANSACTION READ ONLY');
  assert.ok(statements.every(sql => /^(START TRANSACTION READ ONLY|SELECT)/.test(sql)));
});

test('prompt-json is an explicit diagnostic variant with hashed effective body and no Gemma equivalence', async t => {
  const { args, calls, outputPath } = await fixture(t);
  const summary = await runClefConversationCheck({ ...args, requestMode: 'prompt-json' });
  assert.equal(summary.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.response_format, undefined);
  assert.equal(calls[0].body.messages[1].role, 'system');
  assert.match(calls[0].body.messages[1].content, /^Devuelve únicamente un objeto JSON/);
  assert.match(calls[0].body.messages[1].content, /"cliente_felicito_al_asistente"/);
  assert.equal(calls[0].body.messages.at(-1).role, 'user');
  assert.equal(summary.requestMode, 'prompt-json');
  assert.equal(summary.gemmaComparable, false);
  assert.match(summary.requestHash, /^[a-f0-9]{64}$/);
  const artifact = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(artifact.requestHash, summary.requestHash);
  assert.equal(artifact.requestMode, 'prompt-json');
  assert.equal(artifact.gemmaReference.equivalent, false);
  assert.equal(artifact.context, undefined);
  assert.ok(artifact.baselineContext.promptHash);
});

test('invalid variants fail before work and completed artifacts cannot be reused under another variant', async t => {
  const { args, calls, reads, snapshots } = await fixture(t);
  await assert.rejects(runClefConversationCheck({ ...args, requestMode: 'unsupported' }), error => error.code === 'AI_CONFIGURATION');
  assert.equal(calls.length, 0);
  assert.equal(reads.length, 0);
  assert.equal(snapshots.length, 0);
  const first = await runClefConversationCheck(args);
  assert.equal(first.requestMode, 'schema');
  await assert.rejects(runClefConversationCheck({ ...args, requestMode: 'prompt-json' }), error => error.code === 'INVALID_SETTINGS');
  assert.equal(calls.length, 1);
});
