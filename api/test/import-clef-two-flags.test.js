import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticId, expectedRequestHash, importClefTwoFlags, projectClefTwoFlags } from '../scripts/import-clef-two-flags.js';

const ids = ['cliente_molesto', 'asistente_falto_al_respeto'];
function capture() {
  return { format: 1, httpStatus: 200, requestHash: expectedRequestHash, capturedAt: '2026-11-07T20:00:00.000Z',
    envelope: { ok: true, upstream_status_code: 200, privateEnvelopeField: 'DO_NOT_PERSIST', response: { model: 'clef-flash',
      choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: JSON.stringify({ results:
        Object.fromEntries(ids.map(id => [id, { status: 'no_evaluado', value: null, reason: `Motivo sintético de ${id}.`, evidence_message_ids: [] }])) }) } }] } } };
}
function database(initial = {}) {
  let stored = structuredClone(initial), staged, committed = 0, rolledBack = 0;
  const statements = [];
  return { statements, get stored() { return stored; }, get committed() { return committed; }, get rolledBack() { return rolledBack; },
    async beginTransaction() { staged = structuredClone(stored); },
    async query(sql) {
      statements.push(sql);
      if (sql === 'SELECT id FROM app_lock WHERE id = 1 FOR UPDATE') return [[{ id: 1 }]];
      assert.equal(sql, "SELECT payload FROM portal_settings WHERE id = 'settings' FOR UPDATE");
      return [[{ payload: JSON.stringify(staged) }]];
    },
    async execute(sql, parameters) {
      statements.push(sql);
      assert.equal(sql, "UPDATE portal_settings SET payload = ? WHERE id = 'settings'");
      assert.equal(parameters.length, 1);
      staged = JSON.parse(parameters[0]);
      return [{ affectedRows: 1 }];
    },
    async commit() { stored = staged; committed++; }, async rollback() { staged = undefined; rolledBack++; },
  };
}

test('projects only two structured results and preserves the actual response field', () => {
  const value = capture(), result = projectClefTwoFlags(value);
  assert.equal(result.sourceField, 'reasoning_content');
  assert.equal(result.conversationId, '6135');
  assert.deepEqual(Object.keys(result.results), ids);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_PERSIST'));
  value.envelope.response.choices[0].message.content = value.envelope.response.choices[0].message.reasoning_content;
  assert.equal(projectClefTwoFlags(value).sourceField, 'content');
});

test('rejects wrong identity, request, malformed or contradictory results before a database transaction', async () => {
  const changes = [
    value => { value.httpStatus = 500; },
    value => { value.requestHash = 'different'; },
    value => { value.envelope.response.model = 'gemma'; },
    value => { value.envelope.response.choices[0].message.content = 'Invalid nonempty final content'; },
    value => { value.envelope.response.choices[0].finish_reason = 'length'; },
    value => { value.envelope.response.choices[0].message.tool_calls = [{}]; },
    value => { const message = value.envelope.response.choices[0].message; const parsed = JSON.parse(message.reasoning_content); parsed.results[ids[0]].value = 0; message.reasoning_content = JSON.stringify(parsed); },
    value => { const message = value.envelope.response.choices[0].message; const parsed = JSON.parse(message.reasoning_content); parsed.results.extra = {}; message.reasoning_content = JSON.stringify(parsed); },
    value => { const message = value.envelope.response.choices[0].message; const parsed = JSON.parse(message.reasoning_content); parsed.results[ids[0]].reason = 'x'.repeat(161); message.reasoning_content = JSON.stringify(parsed); },
  ];
  for (const change of changes) {
    const value = capture(); change(value);
    await assert.rejects(importClefTwoFlags({ async beginTransaction() { assert.fail('No transaction for invalid capture'); } }, value), /PRIVATE_CAPTURE_IMPORT_FAILED/);
  }
});

test('imports atomically, preserves settings, and repeats without rewriting or printing private results', async () => {
  const original = { version: 17, dailyEnabled: false, dailyTime: '07:00', aiPolicy: { mode: 'single', primaryId: 'gemma-local', version: 6 },
    localModelConfiguration: { version: 3 }, modelDiagnostics: { anotherCheck: { preserved: true } } };
  const db = database(original), value = capture();
  const first = await importClefTwoFlags(db, value);
  assert.deepEqual(first, { success: true, id: diagnosticId, imported: true, count: 2 });
  const { modelDiagnostics, ...saved } = db.stored;
  const { modelDiagnostics: prior, ...before } = original;
  assert.deepEqual(saved, before);
  assert.deepEqual(modelDiagnostics.anotherCheck, prior.anotherCheck);
  assert.deepEqual(modelDiagnostics[diagnosticId], projectClefTwoFlags(value));
  assert.ok(!JSON.stringify(first).includes('Motivo'));
  const updates = db.statements.filter(sql => sql.startsWith('UPDATE')).length;
  // MySQL may reorder JSON object keys. Semantic equality must still be idempotent.
  db.stored.modelDiagnostics[diagnosticId] = Object.fromEntries(Object.entries(modelDiagnostics[diagnosticId]).reverse());
  const second = await importClefTwoFlags(db, value);
  assert.deepEqual(second, { success: true, id: diagnosticId, imported: false, count: 2 });
  assert.equal(db.statements.filter(sql => sql.startsWith('UPDATE')).length, updates);
  assert.equal(db.committed, 2);
  assert.equal(db.rolledBack, 0);
});

test('a conflicting saved diagnostic aborts without replacing any data', async () => {
  const original = { version: 17, dailyEnabled: false, modelDiagnostics: { [diagnosticId]: { requestHash: expectedRequestHash, results: 'different' } } };
  const db = database(original);
  await assert.rejects(importClefTwoFlags(db, capture()), /PRIVATE_CAPTURE_IMPORT_FAILED/);
  assert.deepEqual(db.stored, original);
  assert.equal(db.statements.filter(sql => sql.startsWith('UPDATE')).length, 0);
  assert.equal(db.rolledBack, 1);
});
