import test from 'node:test';
import assert from 'node:assert/strict';
import { getLoadedDecisionInstance } from '../src/services/gatewayDecisionDiscovery.js';

const entry = () => ({ type: 'decision', key: 'cloudflare/clef-flash', decision_type: 'clef', loaded_instances: [
  { id: 'clef-flash', config: { context_length: 8192, eval_batch_size: 8192 } },
], privatePath: '/private/models/file.gguf', base_url: 'http://private-provider:1234', token: 'private-token' });
function clientFor(models) {
  const calls = [];
  return { calls, async invoke(input) { calls.push(input); return { response: { models }, requestId: 'synthetic-native-inventory' }; } };
}

test('exact loaded decision instance is verified without inference or private metadata', async () => {
  const client = clientFor([entry()]);
  const result = await getLoadedDecisionInstance({ client, toolKey: 'gemma', model: 'clef-flash' });
  assert.deepEqual(result, { model: 'clef-flash', modelKey: 'cloudflare/clef-flash', type: 'decision', decisionType: 'clef',
    contextLength: 8192, evalBatchSize: 8192, requestId: 'synthetic-native-inventory' });
  assert.deepEqual(client.calls, [{ toolKey: 'gemma', method: 'GET', path: '/api/v1/models', operation: 'verificar-modelo-decisiones' }]);
  assert.doesNotMatch(JSON.stringify(result), /private-token|private-provider|privatePath|file\.gguf/);
});

test('a model key or chat ID is not accepted as a loaded decision instance', async () => {
  const client = clientFor([entry()]);
  await assert.rejects(getLoadedDecisionInstance({ client, toolKey: 'gemma', model: 'cloudflare/clef-flash' }), { code: 'MODEL_UNAVAILABLE' });
  const chat = entry(); chat.type = 'llm';
  await assert.rejects(getLoadedDecisionInstance({ client: clientFor([chat]), toolKey: 'gemma', model: 'clef-flash' }), { code: 'AI_CONFIGURATION' });
});

test('ambiguous identities and missing capacity metadata fail closed', async () => {
  for (const models of [[entry(), entry()], [{ ...entry(), loaded_instances: [{ id: 'clef-flash', config: {} }] }],
    [{ ...entry(), loaded_instances: [{ id: 'clef-flash', config: { context_length: 0 } }] }],
    [{ ...entry(), loaded_instances: [{ id: 'clef-flash', config: { context_length: 8192.5 } }] }]]) {
    await assert.rejects(getLoadedDecisionInstance({ client: clientFor(models), toolKey: 'gemma', model: 'clef-flash' }), { code: 'INVALID_GATEWAY_CATALOG' });
  }
  const unloaded = entry(); unloaded.loaded_instances = [];
  await assert.rejects(getLoadedDecisionInstance({ client: clientFor([unloaded]), toolKey: 'gemma', model: 'clef-flash' }), { code: 'MODEL_UNAVAILABLE' });
});

test('unsupported inventory envelopes and error responses do not count as verification', async () => {
  for (const response of [{ data: [entry()] }, { models: [entry()], error: 'private error' }, { models: [entry()], ok: false }]) {
    await assert.rejects(getLoadedDecisionInstance({ client: { async invoke() { return { response }; } }, toolKey: 'gemma', model: 'clef-flash' }), { code: 'INVALID_GATEWAY_CATALOG' });
  }
});
