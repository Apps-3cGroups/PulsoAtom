import mysql from 'mysql2/promise';

const iso = value => value instanceof Date ? value.toISOString() : new Date(`${value}Z`).toISOString();
const localDate = (value, timezone) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const actor = role => ({ CLIENTE: 'cliente', ASESOR: 'humano', BOT: 'bot' })[role] || 'sistema';
const mediaType = type => ({ file: 'archivo', call: 'llamada', geopoint: 'ubicación' })[type] || null;
const normalizeIdentity = value => String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');

export function mapAtomConversation(row, events, country, timezone) {
  const startedAt = iso(row.FechaInicioUtc || row.FechaUltimaActividadUtc);
  const messages = [];
  const media = new Set();
  for (const event of events) {
    const type = mediaType(event.TipoOrigen);
    if (type) media.add(type);
    if (!['text', 'quickReply', 'interactive', 'template', 'file', 'call', 'geopoint'].includes(event.TipoOrigen)) continue;
    const text = String(event.Texto || '').trim() || (type ? `[${type}]` : '');
    if (!text) continue;
    // Algunos eventos de Atom traen RolEmisor=ASESOR aunque DeOrigen sea el cliente.
    const isClientOrigin = row.ClienteNombre && normalizeIdentity(event.DeOrigen) === normalizeIdentity(row.ClienteNombre);
    messages.push({ id: String(event.IdEvento), actor: isClientOrigin ? 'cliente' : actor(event.RolEmisor), text, timestamp: iso(event.FechaHoraUtc) });
  }
  return {
    id: String(row.IdConversacion), sourceId: row.IdExternoAtom, demo: false,
    country: country.code, countryName: country.name, sourceCountryCode: Number(row.CodigoPais),
    agent: { id: row.IdAsesorActual == null ? 'sin-asesor' : String(row.IdAsesorActual), name: row.AsesorNombre || 'Sin asesor asignado' },
    client: { name: row.ClienteNombre || 'Cliente', code: row.IdExternoAtom, phoneLast4: null },
    date: localDate(startedAt, timezone), startedAt,
    sourceCreatedAt: row.FechaCreacionUtc ? iso(row.FechaCreacionUtc) : startedAt,
    sourceUpdatedAt: row.FechaActualizacionUtc ? iso(row.FechaActualizacionUtc) : startedAt,
    endedAt: row.FechaFinUtc ? iso(row.FechaFinUtc) : iso(row.FechaUltimaActividadUtc),
    completed: !!row.FechaFinUtc,
    channel: row.CanalNombre || 'Sin canal', topics: [], media: [...media], messages,
    sourceUrl: null, evaluationId: null,
  };
}

export class AtomReader {
  constructor(options, timezone) {
    this.pool = mysql.createPool(options.connection);
    this.tables = Object.fromEntries(Object.entries(options.tables).map(([key, value]) => [key, mysql.escapeId(value)]));
    this.timezone = timezone;
    this.cache = null;
    this.pending = null;
  }
  async fetch() {
    const { conversations: c, documents: d, agents: a, channels: ch, countries: p, events: e } = this.tables;
    const [countryRows] = await this.pool.query(`SELECT DISTINCT p.CodigoPais AS code, p.ISO_Code2 AS iso2, p.NombrePais AS name FROM ${p} p INNER JOIN ${c} c ON c.CodigoPais = p.CodigoPais INNER JOIN ${d} d ON d.IdDocumento = c.IdDocumentoVigente AND d.Estado = 'LISTO' ORDER BY p.NombrePais`);
    const countries = countryRows.map(row => ({ code: String(row.iso2), name: row.name, sourceCode: Number(row.code) }));
    const byCountry = new Map(countries.map(row => [row.sourceCode, row]));
    const [rows] = await this.pool.query(`SELECT c.IdConversacion, c.IdExternoAtom, c.CodigoPais, c.IdAsesorActual, c.ClienteNombre, c.FechaInicioUtc, c.FechaFinUtc, c.FechaUltimaActividadUtc, c.FechaCreacionUtc, c.FechaActualizacionUtc, c.IdDocumentoVigente, a.Nombre AS AsesorNombre, ch.Nombre AS CanalNombre FROM ${c} c INNER JOIN ${d} d ON d.IdDocumento = c.IdDocumentoVigente AND d.Estado = 'LISTO' LEFT JOIN ${a} a ON a.IdAsesor = c.IdAsesorActual LEFT JOIN ${ch} ch ON ch.IdCanal = c.IdCanal ORDER BY c.FechaUltimaActividadUtc DESC, c.IdConversacion DESC`);
    const byDocument = new Map(rows.map(row => [String(row.IdDocumentoVigente), []]));
    const ids = [...byDocument.keys()];
    for (let offset = 0; offset < ids.length; offset += 300) {
      const batch = ids.slice(offset, offset + 300);
      const [eventRows] = await this.pool.query(`SELECT IdDocumento, IdEvento, FechaHoraUtc, Texto, TipoOrigen, RolEmisor, DeOrigen FROM ${e} WHERE IdDocumento IN (${batch.map(() => '?').join(',')}) ORDER BY FechaHoraUtc, NumeroFila`, batch);
      for (const row of eventRows) byDocument.get(String(row.IdDocumento))?.push(row);
    }
    const conversations = rows.map(row => {
      const country = byCountry.get(Number(row.CodigoPais));
      if (!country?.code) throw new Error(`Falta el país ${row.CodigoPais} en el catálogo configurado de Atom.`);
      return mapAtomConversation(row, byDocument.get(String(row.IdDocumentoVigente)) || [], country, this.timezone);
    });
    return { conversations, countries, loadedAt: new Date().toISOString() };
  }
  async read() {
    if (this.cache && Date.now() - this.cache.time < 60_000) return this.cache.value;
    if (!this.pending) this.pending = this.fetch().then(value => { this.cache = { time: Date.now(), value }; return value; }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async close() { await this.pool.end(); }
}
