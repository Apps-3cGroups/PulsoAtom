import test from 'node:test';
import assert from 'node:assert/strict';
import { AtomReader } from '../src/atom.js';
import { isThursdayIngestionRun, readThursdayIngestionSnapshot, thursdayIngestionReadiness } from '../src/thursday-ingestion.js';
import { THURSDAY_INGESTION } from '../src/thursday-handoff.js';
import { ingestionReadiness } from '../src/one-off-evaluations.js';
import { ingestionBatch, ingestionSnapshot } from './helpers/thursday-ingestion-fixture.js';

const sourceBatch = (id, country, values = {}) => ({ id, country, activityDate: '2026-11-12', status: 'PARCIAL',
  expectedDocuments: 21, processedDocuments: 20, failedDocuments: 1,
  finishedAt: '2026-11-13 00:31:00.000000', updatedAt: '2026-11-13 00:31:00.000000', ...values });
function reader(responses) {
  const calls = [];
  return { calls, tables: { batches: '`batches`', countries: '`countries`', documents: '`documents`', conversations: '`conversations`' },
    pool: { execute: async (options, values) => { calls.push({ ...(typeof options === 'string' ? { sql: options } : options), values }); return [responses.shift()]; } } };
}
const countryRows = [{ country: 'HN', sourceCode: 1 }, { country: 'PA', sourceCode: 174 }];

test('terminal partials with finished time and fully accounted counters are settled, never fully successful', () => {
  const snapshot = ingestionSnapshot(['HN', 'PA'].map(country => ingestionBatch({ id: country, countries: [country],
    status: 'PARCIAL', expectedDocuments: 21, processedDocuments: 20, failedDocuments: 1 })));
  const result = thursdayIngestionReadiness(snapshot);
  assert.equal(result.settled, true); assert.equal(result.ready, false); assert.deepEqual(result.missing, []);
  assert.equal(result.terminalPartialBatches.length, 2); assert.equal(result.failedDocuments, 2);
  assert.deepEqual(result.warnings, [{ code: 'THURSDAY_INGESTION_TERMINAL_PARTIAL', batches: 2, failedDocuments: 2 }]);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});

test('active, unfinished, unknown, inconsistent or truncated imports always prevent a Tuesday yield', () => {
  for (const mutate of [
    s => { s.batches[0].status = 'PROCESANDO'; },
    s => { s.batches[0].status = 'PENDIENTE'; },
    s => { s.batches[0].status = 'DESCONOCIDO'; },
    s => { s.batches[0].finishedAt = null; },
    s => { s.batches[0].expectedDocuments = 22; },
    s => { s.batches[0].expectedDocuments = null; },
    s => { s.batches[0].pendingDocuments = 1; },
    s => { s.batches[0].documents = 0; s.batches[0].documentStates = []; },
    s => { s.batches[0].documentStates[0].documents = 19; s.batches[0].documents = 19; },
    s => { s.batches[0].documentStates[0].country = null; },
    s => { s.batches[0].documentStates.push({ status: 'ERROR', country: 'HN', documents: 2 }); s.batches[0].documents += 2; },
    s => { s.batches[0].countryMismatch = true; },
    s => { s.batches[0].scopeKnown = false; },
    s => { s.batches[0].countries = []; },
    s => { s.batches[0].status = 'LISTO'; }, // A success label cannot erase one recorded failure.
    s => { s.batches.pop(); },
    s => { s.truncated = true; },
    s => { delete s.selection; },
  ]) {
    const snapshot = ingestionSnapshot(['HN', 'PA'].map(country => ingestionBatch({ id: country, countries: [country],
      status: 'PARCIAL', expectedDocuments: 21, processedDocuments: 20, failedDocuments: 1 })));
    mutate(snapshot); assert.equal(thursdayIngestionReadiness(snapshot).settled, false);
  }
  assert.equal(thursdayIngestionReadiness(ingestionSnapshot()).ready, true);
});

test('metadata selects finished Thursday batches outside the old UTC window without reading messages', async () => {
  const r = reader([countryRows, [sourceBatch(244, 'HN'), sourceBatch(245, 'PA')],
    [{ batchId: 244, status: 'LISTO', country: 'HN', documents: 20 }, { batchId: 245, status: 'LISTO', country: 'PA', documents: 20 }]]);
  const snapshot = await readThursdayIngestionSnapshot(r, THURSDAY_INGESTION), result = thursdayIngestionReadiness(snapshot);
  assert.equal(result.settled, true); assert.equal(result.ready, false);
  assert.deepEqual(snapshot.batches.map(batch => batch.countries), [['HN'], ['PA']]);
  assert.ok(r.calls.every(call => /^SELECT\b/.test(call.sql) && call.timeout === 10_000));
  assert.match(r.calls[1].sql, /\$\.dia/); assert.match(r.calls[1].sql, /\$\.codigoPais/);
  assert.equal(r.calls[1].values[1].toISOString(), '2026-11-13T00:00:00.000Z');
  assert.doesNotMatch(r.calls.map(call => call.sql).join(' '), /Texto|DetalleError|usuarioAtom|Eventos/);
});

test('unknown new batches block while declared other days and other countries stay outside this handoff', async () => {
  const r = reader([countryRows, [sourceBatch(244, 'HN'), sourceBatch(245, 'PA'), sourceBatch(246, null, { activityDate: null, status: 'PROCESANDO', finishedAt: null }),
    sourceBatch(247, 'HN', { activityDate: '2026-11-13' }), sourceBatch(248, null, { activityDate: null })],
  [{ batchId: 244, status: 'LISTO', country: 'HN', documents: 20 }, { batchId: 245, status: 'LISTO', country: 'PA', documents: 20 },
    { batchId: 248, status: 'LISTO', country: 'MX', documents: 20 }]]);
  const snapshot = await readThursdayIngestionSnapshot(r, THURSDAY_INGESTION);
  assert.deepEqual(snapshot.batches.map(batch => batch.id), ['244', '245', '246']);
  assert.equal(thursdayIngestionReadiness(snapshot).settled, false);
  assert.ok(thursdayIngestionReadiness(snapshot).unfinished.includes('246'));
});

test('pending or unknown document states block even when a batch declares itself terminal', async () => {
  for (const docStatus of ['PENDIENTE', 'PROCESANDO', 'UNKNOWN_NEW_STATE']) {
    const r = reader([countryRows, [sourceBatch(244, 'HN'), sourceBatch(245, 'PA')],
      [{ batchId: 244, status: docStatus, country: 'HN', documents: 1 }, { batchId: 245, status: 'LISTO', country: 'PA', documents: 20 }]]);
    const snapshot = await readThursdayIngestionSnapshot(r, THURSDAY_INGESTION);
    assert.equal(snapshot.batches[0].pendingDocuments, 1); assert.equal(thursdayIngestionReadiness(snapshot).settled, false);
  }
});

test('LISTO documents without a resolvable conversation country cannot establish settled ingestion', async () => {
  const r = reader([countryRows, [sourceBatch(244, 'HN'), sourceBatch(245, 'PA')],
    [{ batchId: 244, status: 'LISTO', country: null, documents: 20 }, { batchId: 245, status: 'LISTO', country: 'PA', documents: 20 }]]);
  const snapshot = await readThursdayIngestionSnapshot(r, THURSDAY_INGESTION);
  assert.equal(snapshot.batches[0].countryMismatch, true); assert.equal(thursdayIngestionReadiness(snapshot).settled, false);
});

test('snapshot revisions catch additional batches, document updates and reprocessing', () => {
  const snapshot = ingestionSnapshot(), original = thursdayIngestionReadiness(snapshot).fingerprint;
  snapshot.batches.reverse(); assert.equal(thursdayIngestionReadiness(snapshot).fingerprint, original);
  for (const mutate of [s => { s.batches[0].updatedAt = '2026-11-13 01:00:00.000000'; },
    s => { s.batches[0].documents++; }, s => { s.batches.push(ingestionBatch({ id: 'new' })); }]) {
    const changed = structuredClone(snapshot); mutate(changed);
    assert.notEqual(thursdayIngestionReadiness(changed).fingerprint, original);
  }
});

test('ordinary one-off snapshot reader and strict success behavior are unchanged', async () => {
  const run = { countries: ['HN', 'PA'], ingestionFrom: THURSDAY_INGESTION.ingestionFrom, expiresAt: THURSDAY_INGESTION.expiresAt };
  assert.equal(isThursdayIngestionRun(run), false); assert.equal(isThursdayIngestionRun(THURSDAY_INGESTION), true);
  assert.equal(isThursdayIngestionRun({ ...THURSDAY_INGESTION, countries: ['HN'] }), false);
  const r = reader([[{ id: 244, status: 'PARCIAL', country: 'HN' }, { id: 245, status: 'LISTO', country: 'PA' }]]);
  const snapshot = await AtomReader.prototype.readIngestionSnapshot.call(r, run);
  assert.deepEqual(snapshot, { batches: [{ id: '244', status: 'PARCIAL', countries: ['HN'] }, { id: '245', status: 'LISTO', countries: ['PA'] }] });
  assert.equal(r.calls.length, 1); assert.doesNotMatch(r.calls[0].sql, /MetadatosJson/);
  assert.equal(ingestionReadiness(snapshot, run).ready, false);
});
