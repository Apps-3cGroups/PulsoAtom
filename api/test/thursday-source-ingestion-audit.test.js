import test from 'node:test';
import assert from 'node:assert/strict';
import { readThursdaySourceIngestionAudit } from '../scripts/thursday-source-ingestion-audit.js';
import { AppError } from '../src/errors.js';

const now = new Date('2026-11-13T11:00:00.000Z');
const countries = [{ sourceCode: 1, country: 'HN' }, { sourceCode: 174, country: 'PA' }];
const batch = (id, sourceCountryCode, extra = {}) => ({ id, sourceCountryCode, status: 'PROCESANDO',
  expectedDocuments: 21, processedDocuments: 20, failedDocuments: 1,
  startedAt: '2026-11-13 00:24:21.413000', updatedAt: '2026-11-13 00:30:08.802000', finishedAt: null, ...extra });
const state = (batchId, status, documents, currentConversations, extra = {}) => ({ batchId, status, documents,
  currentConversations, documentsWithoutConversation: 0, countryMismatchDocuments: 0, ...extra });
function readerFor(responses) {
  const calls = [];
  const reader = { tables: { batches: '`Atom`.`tblLotesIngesta`', documents: '`Atom`.`docs`', conversations: '`Atom`.`conversations`', countries: '`Atom`.`countries`' },
    pool: { execute: async (options, values) => {
      calls.push({ ...options, values });
      if (!responses.length) throw new Error('Unexpected query');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return [next];
    } },
  };
  return { reader, calls };
}

test('reports metadata-day batches despite early stored dates, with ready and nonready documents separated', async () => {
  const { reader, calls } = readerFor([countries,
    [batch(245, '174', { expectedDocuments: null, processedDocuments: 0, failedDocuments: 0 }), batch(244, '1', { status: 'PARCIAL' })],
    [state(244, 'LISTO', 20, 20), state(244, 'ERROR', 1, 0, { documentsWithoutConversation: 1 }), state(245, 'PENDIENTE', 3, 2)],
  ]);
  const result = await readThursdaySourceIngestionAudit(reader, { now });
  assert.equal(result.available, true); assert.equal(result.activityDate, '2026-11-12');
  assert.equal(result.coversExternalQueue, false); assert.equal(result.affectsSchedulerReadiness, false);
  assert.equal(result.truncated, false); assert.equal(result.countryBasis, 'batch_metadata');
  assert.deepEqual(result.countries.map(row => [row.country, row.batches, row.processedDocuments, row.failedDocuments,
    row.documents, row.currentReadyConversations, row.currentNonReadyConversations, row.documentsWithoutConversation]),
  [['HN', 1, 20, 1, 21, 20, 0, 1], ['PA', 1, 0, 0, 3, 0, 2, 0]]);
  assert.equal(result.countries[1].expectedDocuments, null);
  assert.equal(result.batches[1].startedAt, '2026-11-13 00:24:21.413000');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => /^SELECT\b/.test(call.sql) && call.timeout === 10_000));
  assert.deepEqual(calls[1].values, ['2026-11-12', '1', '174']);
  assert.match(calls[1].sql, /JSON_VALID/); assert.match(calls[1].sql, /LIMIT 501/);
  assert.doesNotMatch(calls[1].sql, /FechaInicioUtc\s*[<>]/);
  assert.doesNotMatch(calls.map(call => call.sql).join(' '), /DetalleError|usuarioAtom|Texto|tblEventos|Evento|SELECT\s+\*/);
  assert.equal(result.checkedAt, now.toISOString());
});

test('distinguishes document reprocessing from unique current conversations and does not export extra fields', async () => {
  const privateFields = { MetadatosJson: '{"usuarioAtom":"private-user"}', DetalleError: 'private-error', client: 'private-client' };
  const { reader } = readerFor([countries,
    [batch(244, 1, privateFields), batch(246, 1, { status: 'COMPLETADO', processedDocuments: 20, failedDocuments: 0 })],
    [state(244, 'LISTO', 20, 0, privateFields), state(246, 'LISTO', 20, 20)],
  ]);
  const result = await readThursdaySourceIngestionAudit(reader, { now });
  assert.equal(result.countries[0].processedDocuments, 40);
  assert.equal(result.countries[0].currentReadyConversations, 20);
  assert.equal(result.countries[0].documents, 40);
  assert.doesNotMatch(JSON.stringify(result), /private-|MetadatosJson|DetalleError|usuarioAtom|client/);
});

test('no declared batches means no document query, not external ingestion completion', async () => {
  const { reader, calls } = readerFor([countries, []]);
  const result = await readThursdaySourceIngestionAudit(reader, { now });
  assert.equal(calls.length, 2); assert.deepEqual(result.batches, []);
  assert.ok(result.countries.every(row => row.batches === 0 && row.currentReadyConversations === 0));
  assert.equal(result.coversExternalQueue, false); assert.match(result.notes.join(' '), /no confirma/);
  assert.equal(result.ingestionReady, undefined);
});

test('bounds returned batches and explicitly marks partial audit coverage', async () => {
  const batchRows = Array.from({ length: 501 }, (_, index) => batch(String(1000 - index), 1));
  const { reader, calls } = readerFor([countries, batchRows, []]);
  const result = await readThursdaySourceIngestionAudit(reader, { now });
  assert.equal(result.truncated, true); assert.equal(result.batches.length, 500);
  assert.equal(calls[2].values.length, 500); assert.ok(!calls[2].values.includes('500'));
  assert.equal(result.batchLimit, 500);
});

test('flags source-country mismatches and sanitizes unrecognized state text', async () => {
  const { reader } = readerFor([countries, [batch(244, 1, { status: 'private account text' })],
    [state(244, 'LISTO', 2, 2, { countryMismatchDocuments: 1 }), state(244, 'bad state with private text', 1, 1)],
  ]);
  const result = await readThursdaySourceIngestionAudit(reader, { now });
  assert.equal(result.batches[0].status, 'DESCONOCIDO');
  assert.equal(result.countries[0].countryMismatchDocuments, 1);
  assert.equal(result.countries[0].currentNonReadyConversations, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|bad state/);
});

test('rejects inconsistent source responses without disclosing their raw contents', async () => {
  const mutations = [
    rows => { rows[0] = [countries[0]]; },
    rows => { rows[1][0].sourceCountryCode = 999; },
    rows => { rows[1][0].id = 'private-id'; },
    rows => { rows[1][0].processedDocuments = -1; },
    rows => { rows[1][0].startedAt = 'private-date'; },
    rows => { rows[2][0].currentConversations = 10; },
    rows => { rows[2][0].batchId = 999; },
    rows => { rows[1].push({ ...rows[1][0] }); },
  ];
  for (const mutate of mutations) {
    const rows = [structuredClone(countries), [batch(244, 1)], [state(244, 'LISTO', 1, 1)]];
    mutate(rows); const { reader } = readerFor(rows);
    await assert.rejects(readThursdaySourceIngestionAudit(reader, { now }), error => error instanceof AppError
      && error.code === 'SOURCE_INGESTION_AUDIT_FAILED' && !error.message.includes('private'));
  }
});
