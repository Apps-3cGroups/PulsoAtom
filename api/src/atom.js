import mysql from 'mysql2/promise';
import { AppError } from './errors.js';

const READ_BATCH_SIZE = 300;
const validateConversationIds = ids => {
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id === 'number'
    ? !Number.isSafeInteger(id) || id < 1
    : typeof id !== 'string' || !id.trim() || id.length > 200 || id.includes('\0'))) {
    throw new AppError(422, 'La selección de conversaciones debe contener hasta 1000 identificadores válidos.', 'INVALID_CONVERSATION_SCOPE');
  }
  return [...new Set(ids.map(String))];
};

const iso = value => {
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`).toISOString();
};
const optionalIso = value => {
  if (value == null || value === '') return null;
  try { return iso(value); } catch { return null; }
};
const localDate = (value, timezone) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const mediaType = type => ({ file: 'archivo', call: 'llamada', geopoint: 'ubicación' })[type] || null;
const normalizeIdentity = value => String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');

// Sender metadata, never the wording of a greeting, determines participation.
// Atom uses ATOM for bot messages and SISTEMA/ATOM for automatic follow-ups.
export function atomMessageActor(event, row = {}) {
  const role = normalizeIdentity(event.RolEmisor);
  const origin = normalizeIdentity(event.DeOrigen);
  const direction = normalizeIdentity(event.Direccion);
  if (['log', 'note'].includes(event.TipoOrigen)) return 'sistema';
  if (direction === 'entrante' || role === 'cliente' || (origin && origin === normalizeIdentity(row.ClienteNombre))) return 'cliente';
  if (['atom', 'bot', 'sistema', 'system', 'chatbot'].includes(role)) return 'bot';
  if (['asesor', 'agente', 'humano'].includes(role) || event.IdAsesor != null) return 'humano';
  if (origin && origin === normalizeIdentity(row.AsesorNombre)) return 'humano';
  if (['atom', 'bot', 'sistema', 'system', 'api', 'agent_builder', 'flow builder'].includes(origin)
    || /(?:^|[ _-])cortex(?:$|[ _-])/.test(origin) || /^flujo\b/.test(origin)) return 'bot';
  return 'desconocido';
}

export function mapAtomConversation(row, events, country, timezone) {
  const startedAt = iso(row.FechaInicioUtc || row.FechaUltimaActividadUtc);
  const lastActivityAt = optionalIso(row.FechaUltimaActividadUtc);
  const messages = [];
  const media = new Set();
  for (const event of events) {
    const type = mediaType(event.TipoOrigen);
    if (type) media.add(type);
    if (!['text', 'quickReply', 'interactive', 'template', 'file', 'call', 'geopoint'].includes(event.TipoOrigen)) continue;
    const text = String(event.Texto || '').trim() || (type ? `[${type}]` : '');
    if (!text) continue;
    messages.push({ id: String(event.IdEvento), actor: atomMessageActor(event, row), text, timestamp: iso(event.FechaHoraUtc) });
  }
  // Navigation and date filters use the same activity basis as evaluation
  // selection. Preserve the original start and message timestamps: changing a
  // display date must not invalidate saved model answers or their evidence.
  const latestMessageTime = messages.reduce((latest, message) => Math.max(latest, Date.parse(message.timestamp)), -Infinity);
  const activityAt = lastActivityAt || (Number.isFinite(latestMessageTime) ? new Date(latestMessageTime).toISOString() : startedAt);
  return {
    id: String(row.IdConversacion), sourceId: row.IdExternoAtom,
    sourceDocumentId: row.IdDocumentoVigente == null ? null : String(row.IdDocumentoVigente), demo: false,
    sourceState: String(row.EstadoOrigen || '').trim().toUpperCase(), sourceClosedAt: optionalIso(row.FechaFinUtc),
    ingestionBatchId: row.IdLoteIngesta == null ? null : String(row.IdLoteIngesta),
    ingestionStartedAt: optionalIso(row.IngestaInicioUtc),
    country: country.code, countryName: country.name, sourceCountryCode: Number(row.CodigoPais),
    agent: { id: row.IdAsesorActual == null ? 'sin-asesor' : String(row.IdAsesorActual), name: row.AsesorNombre || 'Sin asesor asignado' },
    client: { name: row.ClienteNombre || 'Cliente', code: row.IdExternoAtom, phoneLast4: null },
    date: localDate(activityAt, timezone), activityDate: localDate(activityAt, timezone),
    startedDate: localDate(startedAt, timezone), startedAt,
    lastActivityAt, activityAt,
    sourceCreatedAt: row.FechaCreacionUtc ? iso(row.FechaCreacionUtc) : startedAt,
    sourceUpdatedAt: row.FechaActualizacionUtc ? iso(row.FechaActualizacionUtc) : startedAt,
    endedAt: row.FechaFinUtc ? iso(row.FechaFinUtc) : activityAt,
    completed: !!row.FechaFinUtc,
    channel: row.CanalNombre || 'Sin canal', topics: [], media: [...media], messages,
    sourceUrl: null, evaluationId: null,
  };
}

export class AtomReader {
  constructor(options, timezone) {
    this.pool = mysql.createPool(options.connection);
    this.tables = Object.fromEntries(Object.entries(options.tables).map(([key, value]) => [key, mysql.escapeId(value)]));
    this.tables.batches ||= mysql.escapeId(options.tables.documents.includes('.') ? `${options.tables.documents.split('.')[0]}.tblLotesIngesta` : 'tblLotesIngesta');
    this.timezone = timezone;
    this.cache = null;
    this.pending = null;
  }
  async fetch({ conversationIds } = {}) {
    const { conversations: c, documents: d, agents: a, channels: ch, countries: p, events: e } = this.tables;
    const scope = conversationIds === undefined ? undefined : validateConversationIds(conversationIds);
    const batches = scope === undefined ? [undefined] : Array.from({ length: Math.ceil(scope.length / READ_BATCH_SIZE) }, (_, i) => scope.slice(i * READ_BATCH_SIZE, (i + 1) * READ_BATCH_SIZE));
    const countryMap = new Map(), rows = [];
    for (const batch of batches) {
      const where = batch ? ` WHERE c.IdConversacion IN (${batch.map(() => '?').join(',')})` : '';
      const [countries] = await this.pool.query(`SELECT DISTINCT p.CodigoPais AS code, p.ISO_Code2 AS iso2, p.NombrePais AS name FROM ${p} p INNER JOIN ${c} c ON c.CodigoPais = p.CodigoPais INNER JOIN ${d} d ON d.IdDocumento = c.IdDocumentoVigente AND d.Estado = 'LISTO'${where} ORDER BY p.NombrePais`, batch);
      for (const country of countries) countryMap.set(String(country.code), country);
      const [conversations] = await this.pool.query(`SELECT c.IdConversacion, c.IdExternoAtom, c.CodigoPais, c.IdAsesorActual, c.ClienteNombre, c.FechaInicioUtc, c.FechaFinUtc, c.FechaUltimaActividadUtc, c.FechaCreacionUtc, c.FechaActualizacionUtc, c.IdDocumentoVigente, c.EstadoOrigen, d.IdLoteIngesta, l.FechaInicioUtc AS IngestaInicioUtc, a.Nombre AS AsesorNombre, ch.Nombre AS CanalNombre FROM ${c} c INNER JOIN ${d} d ON d.IdDocumento = c.IdDocumentoVigente AND d.Estado = 'LISTO' LEFT JOIN ${this.tables.batches} l ON l.IdLoteIngesta = d.IdLoteIngesta LEFT JOIN ${a} a ON a.IdAsesor = c.IdAsesorActual LEFT JOIN ${ch} ch ON ch.IdCanal = c.IdCanal${where} ORDER BY c.FechaUltimaActividadUtc DESC, c.IdConversacion DESC`, batch);
      rows.push(...conversations);
    }
    const countryRows = [...countryMap.values()];
    if (batches.length > 1) {
      countryRows.sort((a, b) => a.name.localeCompare(b.name, 'es'));
      rows.sort((a, b) => new Date(b.FechaUltimaActividadUtc) - new Date(a.FechaUltimaActividadUtc)
        || String(b.IdConversacion).localeCompare(String(a.IdConversacion), 'en', { numeric: true }));
    }
    const countries = countryRows.map(row => ({ code: String(row.iso2), name: row.name, sourceCode: Number(row.code) }));
    const byCountry = new Map(countries.map(row => [row.sourceCode, row]));
    const byDocument = new Map(rows.map(row => [String(row.IdDocumentoVigente), []]));
    const ids = [...byDocument.keys()];
    for (let offset = 0; offset < ids.length; offset += READ_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + READ_BATCH_SIZE);
      const [eventRows] = await this.pool.query(`SELECT IdDocumento, IdEvento, FechaHoraUtc, Texto, TipoOrigen, RolEmisor, DeOrigen, Direccion, IdAsesor FROM ${e} WHERE IdDocumento IN (${batch.map(() => '?').join(',')}) ORDER BY FechaHoraUtc, NumeroFila`, batch);
      for (const row of eventRows) byDocument.get(String(row.IdDocumento))?.push(row);
    }
    const conversations = rows.map(row => {
      const country = byCountry.get(Number(row.CodigoPais));
      if (!country?.code) throw new Error(`Falta el país ${row.CodigoPais} en el catálogo configurado de Atom.`);
      return mapAtomConversation(row, byDocument.get(String(row.IdDocumentoVigente)) || [], country, this.timezone);
    });
    return { conversations, countries, loadedAt: new Date().toISOString() };
  }
  async readIngestionSnapshot(run) {
    const { batches: b, documents: d, conversations: c, countries: p } = this.tables;
    const [rows] = await this.pool.execute(`SELECT l.IdLoteIngesta AS id, l.Estado AS status, p.ISO_Code2 AS country
      FROM ${b} l LEFT JOIN ${d} d ON d.IdLoteIngesta = l.IdLoteIngesta
      LEFT JOIN ${c} c ON c.IdConversacion = d.IdConversacion LEFT JOIN ${p} p ON p.CodigoPais = c.CodigoPais
      WHERE l.FechaInicioUtc >= ? AND l.FechaInicioUtc < ?
      GROUP BY l.IdLoteIngesta, l.Estado, p.ISO_Code2`, [new Date(run.ingestionFrom), new Date(run.expiresAt)]);
    const batches = new Map();
    for (const row of rows) {
      const id = String(row.id);
      if (!batches.has(id)) batches.set(id, { id, status: row.status, countries: [] });
      if (row.country) batches.get(id).countries.push(row.country);
    }
    return { batches: [...batches.values()] };
  }
  async read({ fresh = false, conversationIds } = {}) {
    // Targeted evaluation reads always query the source independently. They
    // neither join an unscoped pending read nor replace the navigation cache.
    if (conversationIds !== undefined) return this.fetch({ conversationIds });
    if (!fresh && this.cache && Date.now() - this.cache.time < 60_000) return this.cache.value;
    if (!this.pending) this.pending = this.fetch().then(value => { this.cache = { time: Date.now(), value }; return value; }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async close() { await this.pool.end(); }
}
