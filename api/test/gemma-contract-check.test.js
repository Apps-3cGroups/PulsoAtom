import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createState } from '../src/data/seed.js';
import { registryFromEnv } from '../src/model-registry.js';
import { checkGemmaContract, gemmaContractConversation } from '../src/gemma-contract-check.js';
import { readGemmaContractState, runGemmaContractCheck } from '../scripts/check-gemma-contract.js';

const privateText = 'PRIVATE_TRANSCRIPT_MUST_NOT_LEAVE';
const env = { GATEWAY_BASE_URL: 'http://gateway.synthetic', AGENT_SHARED_TOKEN: 'PRIVATE_GATEWAY_TOKEN',
  GEMMA_MODEL: 'gemma-synthetic', GEMMA_TOOL_KEY: 'gemma', GEMMA_EVALUATION_ENABLED: 'true' };
function fixture(changeResponse) {
  const state = createState(false);
  state.settings.aiPolicy = { mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local', version: 3 };
  state.conversations = [{ id: 'real-data-never-read', messages: [{ text: privateText }] }];
  for (const v of state.catalog) if (['conversacion_con_areas_de_mejora', 'conversacion_no_resolvio_necesidad_cliente'].includes(v.id)) v.active = false;
  const calls = [];
  const registry = registryFromEnv({ env, fetchImpl: async (url, options) => {
    assert.equal(url, env.GATEWAY_BASE_URL + '/v1/tools/gemma/invoke');
    assert.doesNotMatch(options.body, new RegExp(privateText));
    const body = JSON.parse(options.body).body, input = JSON.parse(body.messages.at(-1).content); calls.push(input);
    assert.deepEqual(input.mensajes, gemmaContractConversation.messages.map(m => ({ id: m.id, actor: m.actor, texto: m.text })));
    const results = Object.fromEntries(input.variables.map(v => {
      let value = v.tipo === 'Descriptor' ? v.id === 'tipo_interaccion' ? 'disponibilidad' : ['ProductoPrueba'] : 0;
      if (v.id === 'cliente_felicito_al_asistente') value = 1;
      if (v.id === 'cliente_molesto') value = null;
      return [v.id, { status: value === null ? 'no_evaluado' : 'evaluado', value, reason: 'Justificación sintética.',
        evidence_message_ids: v.id === 'cliente_felicito_al_asistente' ? ['synthetic-client-2'] : v.tipo === 'Descriptor' ? ['synthetic-client-1'] : [] }];
    }));
    const response = { ok: true, tool_key: 'gemma', request_uuid: `synthetic-gemma-check-${calls.length}`, method: 'POST',
      path: '/v1/chat/completions', upstream_status_code: 200,
      response: { model: body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }] } };
    const altered = changeResponse?.({ results, response, input, number: calls.length, state });
    if (altered) return altered;
    response.response.choices[0].message.content = JSON.stringify({ results });
    return Response.json(response);
  } });
  return { state, registry, calls };
}

test('full preflight targets only enabled Gemma under a dual policy with unavailable Clef and never uses real conversations', async () => {
  const { state, registry, calls } = fixture();
  const before = JSON.stringify(state);
  const result = await checkGemmaContract({ state, registry, redactions: [env.AGENT_SHARED_TOKEN] });
  assert.equal(calls.length, 1); assert.equal(result.requested, 47); assert.equal(result.valid, 47);
  assert.equal(result.evaluated, 46); assert.equal(result.abstained, 1); assert.equal(result.invalid, 0);
  assert.equal(result.contractValid, true); assert.equal(result.reasonableResults, true); assert.equal(result.success, true);
  assert.ok(result.semanticChecks.every(check => check.passed));
  assert.equal(result.attempts[0].responseId, 'synthetic-gemma-check-1');
  assert.equal(JSON.stringify(state), before);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|gateway\.synthetic|Justificación sintética|messages|evidence/);
});

test('preflight keeps 45 valid items and retries only the two format errors once with safe feedback', async () => {
  const { state, registry, calls } = fixture(({ results, number }) => {
    if (number === 1) {
      results.tipo_interaccion.status = 'no_evaluado';
      results.asistente_comunicacion_poco_profesional.evidence_message_ids = ['synthetic-human-1'];
    }
  });
  const result = await checkGemmaContract({ state, registry });
  assert.equal(result.success, true); assert.equal(calls.length, 2);
  assert.deepEqual(result.attempts.map(a => [a.requested, a.valid]), [[47, 45], [2, 2]]);
  assert.deepEqual(calls[1].correccionesFormato, [
    { variableId: 'tipo_interaccion', rules: ['inconsistent_status_value'] },
    { variableId: 'asistente_comunicacion_poco_profesional', rules: ['unexpected_evidence'] },
  ]);
});

test('persistent reason/evidence failures stay invalid after one retry without fabricated results', async () => {
  const { state, registry, calls } = fixture(({ results }) => {
    results.tipo_interaccion.reason = '';
    results.asistente_comunicacion_poco_profesional.evidence_message_ids = ['a', 'b', 'c', 'd'];
  });
  const result = await checkGemmaContract({ state, registry });
  assert.equal(calls.length, 2); assert.equal(result.success, false); assert.equal(result.contractValid, false);
  assert.equal(result.valid, 45); assert.equal(result.invalid, 2);
  assert.deepEqual(result.validationErrors, [
    { variableId: 'tipo_interaccion', rules: ['invalid_reason'] },
    { variableId: 'asistente_comunicacion_poco_profesional', rules: ['invalid_evidence_count'] },
  ]);
});

test('valid abstentions do not masquerade as completed semantic checks', async () => {
  const { state, registry, calls } = fixture(({ results }) => {
    for (const item of Object.values(results)) Object.assign(item, { status: 'no_evaluado', value: null, evidence_message_ids: [] });
  });
  const result = await checkGemmaContract({ state, registry });
  assert.equal(calls.length, 1); assert.equal(result.contractValid, true); assert.equal(result.abstained, 47);
  assert.equal(result.evaluated, 0); assert.equal(result.reasonableResults, false); assert.equal(result.success, false);
  assert.equal(result.sharedRuleResults, 1);
});

test('configuration rejection is not retried and error metadata never contains raw text or credentials', async () => {
  const { state, registry, calls } = fixture(() => Response.json({ error: `${privateText} ${env.AGENT_SHARED_TOKEN}` }, { status: 400 }));
  const result = await checkGemmaContract({ state, registry });
  assert.equal(calls.length, 1); assert.equal(result.success, false); assert.equal(result.error.code, 'AI_CONFIGURATION');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|gateway\.synthetic/);
});

function readonlyConnection(state, { changeAfterFirst = false } = {}) {
  const operations = [], controls = { commits: 0, rollbacks: 0 };
  return { operations, controls,
    async query(sql) {
      operations.push(sql);
      if (sql === 'START TRANSACTION READ ONLY') {
        if (changeAfterFirst && controls.commits === 1) state.settings.version++;
        return [];
      }
      if (sql === 'SELECT payload FROM catalog_items ORDER BY sequence_id') return [state.catalog.map(v => ({ payload: JSON.stringify(v) }))];
      if (sql === "SELECT payload FROM portal_settings WHERE id = 'settings'") return [[{ payload: JSON.stringify(state.settings) }]];
      assert.fail(`Unexpected database operation: ${sql}`);
    },
    async commit() { controls.commits++; }, async rollback() { controls.rollbacks++; },
  };
}

test('CLI helper reads only catalog/settings in read-only snapshots, checks version changes and never writes', async () => {
  for (const changeAfterFirst of [false, true]) {
    const { state, registry } = fixture();
    const connection = readonlyConnection(state, { changeAfterFirst });
    const result = await runGemmaContractCheck({ connection, registry });
    assert.equal(result.configurationUnchanged, !changeAfterFirst); assert.equal(result.success, !changeAfterFirst);
    assert.equal(connection.controls.commits, 2); assert.equal(connection.controls.rollbacks, 0);
    assert.equal(connection.operations.length, 6);
    assert.ok(connection.operations.every(sql => sql === 'START TRANSACTION READ ONLY' || sql.startsWith('SELECT payload FROM')));
  }
});

test('read failure rolls back and exposes no source tables to the checker', async () => {
  let rolledBack = false;
  await assert.rejects(readGemmaContractState({ async query(sql) {
    if (sql === 'START TRANSACTION READ ONLY') return [];
    throw new Error('synthetic DB failure');
  }, async rollback() { rolledBack = true; } }));
  assert.equal(rolledBack, true);
});

test('CLI help and invalid arguments do not load server configuration or invoke models', () => {
  const script = new URL('../scripts/check-gemma-contract.js', import.meta.url);
  const help = spawnSync(process.execPath, [script.pathname, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /No consulta Atom/);
  const invalid = spawnSync(process.execPath, [script.pathname, '--token', env.AGENT_SHARED_TOKEN], { encoding: 'utf8' });
  assert.equal(invalid.status, 2); assert.doesNotMatch(invalid.stderr, /PRIVATE_|gateway\.synthetic/); assert.equal(invalid.stdout, '');
});
