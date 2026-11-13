import { AppError } from '../src/errors.js';

const DAY = '2026-11-12';
const COUNTRIES = ['HN', 'PA'];
const MAX_BATCHES = 500;
const fail = () => { throw new AppError(409, 'No se pudo verificar el agregado de la carga de origen.', 'SOURCE_INGESTION_AUDIT_FAILED'); };
const count = value => {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail();
  return number;
};
const stateName = value => /^[A-Z_]{1,40}$/.test(String(value || '')) ? String(value) : 'DESCONOCIDO';
const storedDate = value => {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(value)) fail();
  return value;
};
const sumKnown = (rows, key) => rows.some(row => row[key] === null) ? null : rows.reduce((sum, row) => sum + row[key], 0);

// This diagnostic deliberately does not feed scheduler readiness. Batch metadata
// selects the requested activity day even when ingestion dates are mislabeled.
// No events, transcripts, metadata objects or raw error details leave the source.
export async function readThursdaySourceIngestionAudit(reader, { now = new Date() } = {}) {
  const { batches: b, documents: d, conversations: c, countries: p } = reader.tables;
  if (!b || !d || !c || !p) fail();
  const select = async (sql, values) => {
    const [rows] = await reader.pool.execute({ sql, timeout: 10_000 }, values);
    return rows;
  };
  const countryRows = await select(`SELECT CodigoPais AS sourceCode, ISO_Code2 AS country FROM ${p}
    WHERE ISO_Code2 IN (?, ?)`, COUNTRIES);
  if (countryRows.length !== 2 || new Set(countryRows.map(row => row.country)).size !== 2
    || countryRows.some(row => !COUNTRIES.includes(row.country) || !Number.isSafeInteger(Number(row.sourceCode)) || Number(row.sourceCode) < 1)) fail();
  const countryBySource = new Map(countryRows.map(row => [String(row.sourceCode), row.country]));
  const metadata = `CASE WHEN JSON_VALID(l.MetadatosJson) THEN l.MetadatosJson ELSE '{}' END`;
  const batchRows = await select(`SELECT l.IdLoteIngesta AS id, l.Estado AS status,
    JSON_UNQUOTE(JSON_EXTRACT(${metadata}, '$.codigoPais')) AS sourceCountryCode,
    l.DocumentosEsperados AS expectedDocuments, l.DocumentosProcesados AS processedDocuments,
    l.DocumentosFallidos AS failedDocuments,
    DATE_FORMAT(l.FechaInicioUtc, '%Y-%m-%d %H:%i:%s.%f') AS startedAt,
    DATE_FORMAT(l.FechaActualizacionUtc, '%Y-%m-%d %H:%i:%s.%f') AS updatedAt,
    DATE_FORMAT(l.FechaFinUtc, '%Y-%m-%d %H:%i:%s.%f') AS finishedAt
    FROM ${b} l WHERE JSON_UNQUOTE(JSON_EXTRACT(${metadata}, '$.dia')) = ?
      AND JSON_UNQUOTE(JSON_EXTRACT(${metadata}, '$.codigoPais')) IN (?, ?)
    ORDER BY l.IdLoteIngesta DESC LIMIT ${MAX_BATCHES + 1}`,
  [DAY, ...countryRows.map(row => String(row.sourceCode))]);
  const truncated = batchRows.length > MAX_BATCHES;
  const batches = batchRows.slice(0, MAX_BATCHES).map(row => {
    const id = String(row.id), country = countryBySource.get(String(row.sourceCountryCode));
    if (!/^\d{1,20}$/.test(id) || !country) fail();
    return { id, country, status: stateName(row.status), expectedDocuments: count(row.expectedDocuments),
      processedDocuments: count(row.processedDocuments), failedDocuments: count(row.failedDocuments),
      startedAt: storedDate(row.startedAt), updatedAt: storedDate(row.updatedAt), finishedAt: storedDate(row.finishedAt),
      documents: 0, currentReadyConversations: 0, currentNonReadyConversations: 0,
      documentsWithoutConversation: 0, countryMismatchDocuments: 0, documentStates: [] };
  });
  if (new Set(batches.map(batch => batch.id)).size !== batches.length) fail();
  if (batches.length) {
    const rows = await select(`SELECT d.IdLoteIngesta AS batchId, d.Estado AS status, COUNT(*) AS documents,
      COUNT(DISTINCT CASE WHEN c.IdDocumentoVigente = d.IdDocumento THEN c.IdConversacion END) AS currentConversations,
      SUM(CASE WHEN c.IdConversacion IS NULL THEN 1 ELSE 0 END) AS documentsWithoutConversation,
      SUM(CASE WHEN c.IdConversacion IS NOT NULL AND CAST(c.CodigoPais AS CHAR) <>
        JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(l.MetadatosJson) THEN l.MetadatosJson ELSE '{}' END, '$.codigoPais'))
        THEN 1 ELSE 0 END) AS countryMismatchDocuments
      FROM ${d} d INNER JOIN ${b} l ON l.IdLoteIngesta = d.IdLoteIngesta
      LEFT JOIN ${c} c ON c.IdConversacion = d.IdConversacion
      WHERE d.IdLoteIngesta IN (${batches.map(() => '?').join(',')})
      GROUP BY d.IdLoteIngesta, d.Estado`, batches.map(batch => batch.id));
    const byId = new Map(batches.map(batch => [batch.id, batch]));
    for (const row of rows) {
      const batch = byId.get(String(row.batchId));
      const documents = count(row.documents), currentConversations = count(row.currentConversations);
      const withoutConversation = count(row.documentsWithoutConversation), mismatched = count(row.countryMismatchDocuments);
      if (!batch || [documents, currentConversations, withoutConversation, mismatched].includes(null)
        || currentConversations > documents || withoutConversation > documents || mismatched > documents) fail();
      const status = stateName(row.status);
      batch.documents += documents;
      batch[status === 'LISTO' ? 'currentReadyConversations' : 'currentNonReadyConversations'] += currentConversations;
      batch.documentsWithoutConversation += withoutConversation;
      batch.countryMismatchDocuments += mismatched;
      batch.documentStates.push({ status, documents, currentConversations });
    }
  }
  const countries = COUNTRIES.map(country => {
    const own = batches.filter(batch => batch.country === country);
    return { country, batches: own.length, expectedDocuments: sumKnown(own, 'expectedDocuments'),
      processedDocuments: sumKnown(own, 'processedDocuments'), failedDocuments: sumKnown(own, 'failedDocuments'),
      documents: sumKnown(own, 'documents'), currentReadyConversations: sumKnown(own, 'currentReadyConversations'),
      currentNonReadyConversations: sumKnown(own, 'currentNonReadyConversations'),
      documentsWithoutConversation: sumKnown(own, 'documentsWithoutConversation'),
      countryMismatchDocuments: sumKnown(own, 'countryMismatchDocuments') };
  });
  return { available: true, readOnly: true, checkedAt: now.toISOString(), activityDate: DAY,
    selection: 'batch_metadata_activity_day', timestampBasis: 'source_fields_as_stored_timezone_unverified',
    countryBasis: 'batch_metadata', coversExternalQueue: false, affectsSchedulerReadiness: false,
    truncated, batchLimit: MAX_BATCHES, countries, batches,
    notes: [
      'Se incluyen lotes cuya metadata declara el jueves, independientemente de su fecha de ingesta.',
      'Los contadores de Automations representan documentos procesados por lote; pueden incluir reprocesamientos.',
      'Las conversaciones vigentes LISTO de estos lotes no equivalen al inventario elegible completo del jueves.',
      'Este agregado no confirma que Automations haya terminado ni muestra su cola externa.',
    ] };
}
