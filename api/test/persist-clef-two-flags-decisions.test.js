import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticId, projectClefTwoFlagsDecisions, persistClefTwoFlagsDecisions } from '../scripts/persist-clef-two-flags-decisions.js';

const sourceHash = 'a'.repeat(64), requestHash = 'b'.repeat(64);
const version = 'clef-flash-decisions-1';
const ids = ['cliente_molesto', 'asistente_falto_al_respeto'];
function fixture(values = [0, null]) {
  const artifact = { format: 1, model: 'clef-flash', conversationId: '6135', purpose: 'isolated-real-content-probe', requestMode: 'schema',
    decisionInstructionsVersion: version, summary: { success: true, status: 'completed', decisionInstructionsVersion: version },
    sourceUnchanged: true, configurationUnchanged: true, idleAfter: true, validationErrors: [], context: { sourceHash },
    requestHash, requestedVariableIds: [...ids], responseField: 'reasoning_content', privateExtra: 'DO_NOT_STORE',
    results: ids.map((variableId, i) => ({ variableId, type: 'Flag', method: 'IA', status: values[i] === null ? 'no_evaluado' : 'evaluado',
      value: values[i], reason: 'Motivo privado sintético.', evidenceMessageIds: values[i] === 1 ? ['message-validated-by-probe'] : [] })) };
  const capture = { format: 1, httpStatus: 200, requestHash, capturedAt: '2026-11-07T20:00:00.000Z',
    envelope: { ok: true, upstream_status_code: 200, response: { model: 'clef-flash', raw: 'DO_NOT_STORE' } }, token: 'DO_NOT_STORE' };
  return { artifact, capture };
}
function database(initial = {}) {
  let saved = structuredClone(initial), pending;
  const calls = [];
  return { calls, read: () => structuredClone(saved),
    async beginTransaction() { calls.push('begin'); },
    async query(sql) {
      calls.push(sql);
      if (sql === 'SELECT id FROM app_lock WHERE id = 1 FOR UPDATE') return [[{ id: 1 }]];
      assert.equal(sql, "SELECT payload FROM portal_settings WHERE id = 'settings' FOR UPDATE");
      return [[{ payload: JSON.stringify(saved) }]];
    },
    async execute(sql, parameters) {
      calls.push(sql);
      assert.equal(sql, "UPDATE portal_settings SET payload = ? WHERE id = 'settings'");
      assert.equal(parameters.length, 1);
      pending = JSON.parse(parameters[0]);
      return [{ affectedRows: 1 }];
    },
    async commit() { if (pending) saved = pending; pending = undefined; calls.push('commit'); },
    async rollback() { pending = undefined; calls.push('rollback'); },
  };
}

test('new diagnostic preserves validated present, absent and abstained decisions without reclassification', () => {
  for (const values of [[0, 1], [null, 0], [null, null]]) {
    const { artifact, capture } = fixture(values);
    const projected = projectClefTwoFlagsDecisions(artifact, capture, sourceHash);
    assert.deepEqual(ids.map(id => projected.results[id].value), values);
    assert.deepEqual(ids.map(id => projected.results[id].status), values.map(value => value === null ? 'no_evaluado' : 'evaluado'));
    assert.equal(projected.decisionInstructionsVersion, version);
    assert.equal(projected.sourceField, 'reasoning_content');
    assert.equal(projected.sourceHash, sourceHash);
    assert.ok(!JSON.stringify(projected).includes('DO_NOT_STORE'));
  }
  const { artifact, capture } = fixture([null, null]);
  artifact.results[0].reason = 'No hay evidencia de enojo.';
  assert.equal(projectClefTwoFlagsDecisions(artifact, capture, sourceHash).results.cliente_molesto.value, null);
});

test('invalid, partial, stale or mismatched results cannot reach a database transaction', async () => {
  const changes = [
    ({ artifact }) => { artifact.summary.success = false; },
    ({ artifact }) => { artifact.validationErrors = [{ variableId: ids[0] }]; },
    ({ artifact }) => { artifact.decisionInstructionsVersion = 'old'; },
    ({ artifact }) => { artifact.summary.decisionInstructionsVersion = 'old'; },
    ({ artifact }) => { artifact.context.sourceHash = 'c'.repeat(64); },
    ({ artifact }) => { artifact.sourceUnchanged = false; },
    ({ artifact }) => { artifact.configurationUnchanged = false; },
    ({ artifact }) => { artifact.idleAfter = false; },
    ({ artifact }) => { artifact.results[0].status = 'no_evaluado'; },
    ({ artifact }) => { artifact.results[0].value = 1; },
    ({ artifact }) => { artifact.results[0].reason = 'x'.repeat(1001); },
    ({ artifact }) => { artifact.results[1].variableId = ids[0]; },
    ({ capture }) => { capture.requestHash = 'c'.repeat(64); },
    ({ capture }) => { capture.envelope.response.model = 'gemma'; },
  ];
  for (const change of changes) {
    const data = fixture(), db = database(); change(data);
    await assert.rejects(persistClefTwoFlagsDecisions(db, data.artifact, data.capture, sourceHash));
    assert.deepEqual(db.calls, []);
  }
});

test('private import preserves prior diagnostics and policy, and repeats idempotently with safe metadata only', async () => {
  const initial = { version: 11, dailyEnabled: false, aiPolicy: { mode: 'single', primaryId: 'gemma-local', version: 6 },
    modelDiagnostics: { clefTwoFlags6135: { prior: true } }, customSetting: { preserved: true } };
  const db = database(initial), { artifact, capture } = fixture([1, 0]);
  const first = await persistClefTwoFlagsDecisions(db, artifact, capture, sourceHash);
  assert.deepEqual(first, { success: true, id: diagnosticId, imported: true, count: 2 });
  const saved = db.read(), projected = saved.modelDiagnostics[diagnosticId];
  delete saved.modelDiagnostics[diagnosticId];
  assert.deepEqual(saved, initial);
  assert.deepEqual(projected.results.cliente_molesto.evidence_message_ids, ['message-validated-by-probe']);
  const second = await persistClefTwoFlagsDecisions(db, artifact, capture, sourceHash);
  assert.deepEqual(second, { success: true, id: diagnosticId, imported: false, count: 2 });
  assert.equal(db.calls.filter(call => call.startsWith('UPDATE')).length, 1);
  assert.ok(!JSON.stringify([first, second]).includes('Motivo'));
});

test('conflict rolls back instead of replacing an earlier decision capture', async () => {
  const initial = { version: 11, modelDiagnostics: { [diagnosticId]: { requestHash: 'old' } } };
  const db = database(initial), { artifact, capture } = fixture();
  await assert.rejects(persistClefTwoFlagsDecisions(db, artifact, capture, sourceHash));
  assert.equal(db.calls.at(-1), 'rollback');
  assert.equal(db.calls.some(call => call.startsWith('UPDATE')), false);
  assert.deepEqual(db.read(), initial);
});
