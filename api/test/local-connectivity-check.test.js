import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConnectivity } from '../scripts/check-local-connectivity.js';
import { AppError } from '../src/errors.js';

function fixture({ discoveryError, inferenceError } = {}) {
  const queries = [], logs = [];
  let calls = 0;
  const evaluator = {
    toolKey: 'gemma', withRuntime(options) { assert.equal(options.timeoutMs, 60000); return this; },
    async discovery() {
      if (discoveryError) throw discoveryError;
      return { models: { data: [{ id: 'clef-flash' }] }, requestId: 'inventory-1' };
    },
    async evaluate(conversation, variables) {
      calls++;
      assert.equal(conversation.id, 'pulso-connectivity-synthetic');
      assert.equal(variables.length, 1);
      if (inferenceError) throw inferenceError;
      return { model: 'clef-flash', responseId: 'answer-1', results: [{ variableId: variables[0].id,
        status: 'evaluado', value: 1, evidence: [{ messageId: 'synthetic-client' }] }], validationErrors: [] };
    },
  };
  const connection = {
    async query(sql) { queries.push(sql); return [[{ payload: { localModelConfiguration: { version: 7 } } }]]; },
    async commit() {}, async rollback() {},
  };
  const registryFactory = () => ({ forState({ settings }) {
    assert.equal(settings.localModelConfiguration.version, 7);
    return { resolve(id) { assert.equal(id, 'clef-local'); return { provider: 'gateway', model: 'clef-flash', evaluator }; },
      snapshot() { return { configurationHash: 'a'.repeat(64) }; } };
  } });
  return { args: { connection, registryFactory, profileId: 'clef-local', emit: line => logs.push(line) }, queries, logs, calls: () => calls };
}

test('reads only settings and tests a synthetic checklist without persistence', async () => {
  const f = fixture();
  const result = await checkConnectivity(f.args);
  assert.equal(result.success, true);
  assert.equal(result.databaseWrites, false);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.queries, ['START TRANSACTION READ ONLY', "SELECT payload FROM portal_settings WHERE id = 'settings'"]);
});

test('discovery timeout prevents inference and exposes only safe error metadata', async () => {
  const f = fixture({ discoveryError: new AppError(502, 'secret-token and private URL', 'AI_TRANSIENT', { upstreamStatus: 504 }) });
  const result = await checkConnectivity(f.args);
  assert.equal(result.success, false);
  assert.equal(result.stage, 'discovery');
  assert.equal(result.upstreamStatus, 504);
  assert.equal(f.calls(), 0);
  assert.ok(!f.logs.join('').includes('secret-token'));
});

test('does not retry inference or expose unexpected errors', async () => {
  const f = fixture({ inferenceError: new Error('secret credentials') });
  const result = await checkConnectivity(f.args);
  assert.equal(result.success, false);
  assert.equal(result.stage, 'synthetic-inference');
  assert.equal(f.calls(), 1);
  assert.equal(result.code, 'CONNECTIVITY_CHECK_FAILED');
  assert.ok(!f.logs.join('').includes('secret credentials'));
});
