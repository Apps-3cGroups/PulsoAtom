import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

const ID = 'thursday-2026-11-12-after-recovery';
const DAY = '2026-11-12';
const COUNTRIES = ['HN', 'PA'];
const FROM = '2026-11-13T06:00:00.000Z';
const TO = '2026-11-14T06:00:00.000Z';
const FALLBACK_FROM = '2026-11-13T00:00:00.000Z';
const LIMIT = 500;
const SELECTION = 'thursday-metadata-v1';
const fail = () => { throw new AppError(409, 'No se pudo verificar el estado de la ingesta del jueves.', 'THURSDAY_INGESTION_UNVERIFIED'); };
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const count = value => value == null ? null : validCount(Number(value)) ? Number(value) : null;
const status = value => /^[A-Z_]{1,40}$/.test(String(value || '')) ? String(value) : 'DESCONOCIDO';
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(value)
  && Number.isFinite(Date.parse(`${value.replace(' ', 'T')}Z`)) ? value : null;
const sameCountries = countries => Array.isArray(countries) && countries.length === 2
  && new Set(countries).size === 2 && COUNTRIES.every(country => countries.includes(country));

export const isThursdayIngestionRun = run => run?.handoffId === ID && run.activityDate === DAY
  && run.ingestionFrom === FROM && run.expiresAt === TO && sameCountries(run.countries);

// This is a separate reader for the one authorized handoff. Ordinary one-off
// imports keep their existing window-based selection and success requirement.
export async function readThursdayIngestionSnapshot(reader, run) {
  if (!isThursdayIngestionRun(run)) fail();
  const { batches: b, documents: d, conversations: c, countries: p } = reader.tables;
  const read = async (sql, values = []) => (await reader.pool.execute({ sql, timeout: 10_000 }, values))[0];
  const countryRows = await read(`SELECT CodigoPais AS sourceCode, ISO_Code2 AS country FROM ${p} WHERE ISO_Code2 IN (?, ?)`, COUNTRIES);
  if (countryRows.length !== 2 || !sameCountries(countryRows.map(row => row.country))
    || countryRows.some(row => !Number.isSafeInteger(Number(row.sourceCode)) || Number(row.sourceCode) < 1)
    || new Set(countryRows.map(row => String(row.sourceCode))).size !== 2) fail();
  const metadata = `CASE WHEN JSON_VALID(l.MetadatosJson) THEN l.MetadatosJson ELSE '{}' END`;
  // A declared activity day wins over timestamps. The wider fallback covers the
  // observed six-hour date-label discrepancy, but never proves completion.
  const rows = await read(`SELECT l.IdLoteIngesta AS id, l.Estado AS status,
    JSON_UNQUOTE(JSON_EXTRACT(${metadata}, '$.dia')) AS activityDate, p.ISO_Code2 AS country,
    l.DocumentosEsperados AS expectedDocuments, l.DocumentosProcesados AS processedDocuments,
    l.DocumentosFallidos AS failedDocuments,
    DATE_FORMAT(l.FechaFinUtc, '%Y-%m-%d %H:%i:%s.%f') AS finishedAt,
    DATE_FORMAT(l.FechaActualizacionUtc, '%Y-%m-%d %H:%i:%s.%f') AS updatedAt
    FROM ${b} l LEFT JOIN ${p} p ON CAST(p.CodigoPais AS CHAR) = JSON_UNQUOTE(JSON_EXTRACT(${metadata}, '$.codigoPais'))
    WHERE (JSON_UNQUOTE(JSON_EXTRACT(${metadata}, '$.dia')) = ? OR (l.FechaInicioUtc >= ? AND l.FechaInicioUtc < ?))
      AND (p.ISO_Code2 IN (?, ?) OR p.ISO_Code2 IS NULL)
    ORDER BY l.IdLoteIngesta DESC LIMIT ${LIMIT + 1}`,
  [DAY, new Date(FALLBACK_FROM), new Date(TO), ...COUNTRIES]);
  const truncated = rows.length > LIMIT;
  const selected = rows.slice(0, LIMIT).filter(row => row.activityDate === DAY || !validDay(row.activityDate));
  const batches = selected.map(row => {
    const id = String(row.id);
    if (!/^\d{1,20}$/.test(id)) fail();
    return { id, countries: COUNTRIES.includes(row.country) ? [row.country] : [],
      scopeKnown: row.activityDate === DAY && COUNTRIES.includes(row.country),
      status: status(row.status), finishedAt: timestamp(row.finishedAt), updatedAt: timestamp(row.updatedAt),
      expectedDocuments: count(row.expectedDocuments), processedDocuments: count(row.processedDocuments),
      failedDocuments: count(row.failedDocuments), pendingDocuments: 0, documents: 0,
      countryMismatch: false, documentStates: [] };
  });
  if (new Set(batches.map(batch => batch.id)).size !== batches.length) fail();
  if (batches.length) {
    const documents = await read(`SELECT d.IdLoteIngesta AS batchId, d.Estado AS status,
      p.ISO_Code2 AS country, COUNT(*) AS documents
      FROM ${d} d LEFT JOIN ${c} c ON c.IdConversacion = d.IdConversacion
      LEFT JOIN ${p} p ON p.CodigoPais = c.CodigoPais
      WHERE d.IdLoteIngesta IN (${batches.map(() => '?').join(',')})
      GROUP BY d.IdLoteIngesta, d.Estado, p.ISO_Code2`, batches.map(batch => batch.id));
    const byId = new Map(batches.map(batch => [batch.id, batch]));
    for (const row of documents) {
      const batch = byId.get(String(row.batchId)), total = count(row.documents), name = status(row.status);
      if (!batch || total === null) fail();
      batch.documents += total;
      if (!['LISTO', 'ERROR', 'FALLIDO'].includes(name)) batch.pendingDocuments += total;
      if (batch.scopeKnown && (row.country && !batch.countries.includes(row.country)
        || name === 'LISTO' && !row.country)) batch.countryMismatch = true;
      if (!batch.scopeKnown && COUNTRIES.includes(row.country) && !batch.countries.includes(row.country)) batch.countries.push(row.country);
      batch.documentStates.push({ status: name, country: COUNTRIES.includes(row.country) ? row.country : row.country ? 'OTHER' : null, documents: total });
    }
  }
  // An unknown country with no documents must remain visible to the guard.
  // Clearly identified other-country documents cannot consume this handoff.
  const relevant = batches.filter(batch => batch.countries.length || !batch.documentStates.length
    || batch.documentStates.some(row => row.country !== 'OTHER'));
  return { selection: SELECTION, activityDate: DAY, countries: [...COUNTRIES], truncated, batches: relevant };
}

export function thursdayIngestionReadiness(snapshot) {
  const unavailable = { ready: false, settled: false, missing: [...COUNTRIES], unfinished: [],
    terminalPartialBatches: [], failedDocuments: 0, warnings: [{ code: 'THURSDAY_INGESTION_UNVERIFIED' }], fingerprint: null };
  if (!snapshot || snapshot.selection !== SELECTION || snapshot.activityDate !== DAY || !sameCountries(snapshot.countries)
    || !Array.isArray(snapshot.batches) || typeof snapshot.truncated !== 'boolean') return unavailable;
  const batches = snapshot.batches;
  const valid = batch => batch && typeof batch.id === 'string' && Array.isArray(batch.countries)
    && batch.countries.every(country => COUNTRIES.includes(country)) && new Set(batch.countries).size === batch.countries.length
    && typeof batch.scopeKnown === 'boolean' && typeof batch.countryMismatch === 'boolean'
    && typeof batch.status === 'string' && validCount(batch.pendingDocuments) && validCount(batch.documents)
    && Array.isArray(batch.documentStates) && batch.documentStates.every(row => row && typeof row.status === 'string'
      && validCount(row.documents) && ['HN', 'PA', 'OTHER', null].includes(row.country));
  if (batches.some(batch => !valid(batch)) || new Set(batches.map(batch => batch.id)).size !== batches.length) return unavailable;
  const documentsMatch = batch => {
    const readyRows = batch.documentStates.filter(row => row.status === 'LISTO');
    const ready = readyRows.reduce((sum, row) => sum + row.documents, 0);
    const failed = batch.documentStates.filter(row => ['ERROR', 'FALLIDO'].includes(row.status)).reduce((sum, row) => sum + row.documents, 0);
    // A failed download may leave no document; a processed success must already
    // have its LISTO document. Counters alone cannot attest persisted ingestion.
    return readyRows.every(row => batch.countries.includes(row.country))
      && ready === batch.processedDocuments && failed <= batch.failedDocuments && ready + failed === batch.documents;
  };
  const terminal = batch => batch.scopeKnown && batch.countries.length === 1 && !batch.countryMismatch
    && ['LISTO', 'PARCIAL'].includes(batch.status) && !!timestamp(batch.finishedAt)
    && [batch.expectedDocuments, batch.processedDocuments, batch.failedDocuments].every(validCount)
    && batch.expectedDocuments === batch.processedDocuments + batch.failedDocuments
    && batch.pendingDocuments === 0 && documentsMatch(batch) && (batch.status !== 'LISTO' || batch.failedDocuments === 0);
  const missing = COUNTRIES.filter(country => !batches.some(batch => batch.scopeKnown && batch.countries.includes(country)));
  const unfinished = batches.filter(batch => !terminal(batch)).map(batch => batch.id);
  const terminalPartialBatches = batches.filter(batch => terminal(batch) && batch.status === 'PARCIAL').map(batch => batch.id);
  const failedDocuments = batches.reduce((sum, batch) => sum + (validCount(batch.failedDocuments) ? batch.failedDocuments : 0), 0);
  const settled = !snapshot.truncated && !missing.length && !unfinished.length;
  const ready = settled && !terminalPartialBatches.length && failedDocuments === 0;
  const warnings = [
    ...(snapshot.truncated ? [{ code: 'THURSDAY_INGESTION_TRUNCATED' }] : []),
    ...(missing.length ? [{ code: 'THURSDAY_INGESTION_COUNTRY_MISSING', countries: missing }] : []),
    ...(unfinished.length ? [{ code: 'THURSDAY_INGESTION_PENDING', batches: unfinished.length }] : []),
    ...(terminalPartialBatches.length ? [{ code: 'THURSDAY_INGESTION_TERMINAL_PARTIAL', batches: terminalPartialBatches.length, failedDocuments }] : []),
  ];
  const canonical = batches.map(batch => ({ id: batch.id, countries: [...batch.countries].sort(), scopeKnown: batch.scopeKnown,
    status: batch.status, finishedAt: batch.finishedAt, updatedAt: batch.updatedAt, expectedDocuments: batch.expectedDocuments,
    processedDocuments: batch.processedDocuments, failedDocuments: batch.failedDocuments,
    pendingDocuments: batch.pendingDocuments, documents: batch.documents, countryMismatch: batch.countryMismatch,
    documentStates: [...(batch.documentStates || [])].map(({ status, country, documents }) => ({ status, country, documents }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })).sort((a, b) => a.id.localeCompare(b.id));
  const fingerprint = createHash('sha256').update(JSON.stringify([snapshot.selection, snapshot.activityDate, snapshot.truncated, canonical])).digest('hex');
  return { ready, settled, missing, unfinished, terminalPartialBatches, failedDocuments, warnings, fingerprint };
}
