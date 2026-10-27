import { createHash, timingSafeEqual } from 'node:crypto';
import mysql from 'mysql2/promise';
import { AppError } from './errors.js';

export function matchesSomos3cPassword(storedHash, password) {
  if (!/^[a-f0-9]{128}$/i.test(storedHash || '')) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = createHash('sha512').update(password, 'utf8').digest();
  return timingSafeEqual(expected, actual);
}

export class Somos3cIdentity {
  constructor(options) {
    this.mode = 'portal-user';
    this.pool = mysql.createPool(options.connection);
    this.tables = Object.fromEntries(Object.entries(options.tables).map(([key, value]) => [key, mysql.escapeId(`${options.connection.database}.${value}`)]));
  }
  async lookup(username, { credentials = false } = {}) {
    const { users, people, userRoles, roles } = this.tables;
    const [rows] = await this.pool.execute(`SELECT u.IdUsuarioPortal AS id, u.usuario AS username, u.activo AS active,
      u.requiereCambioClave AS changeRequired, u.bloqueadoHasta AS blockedUntil,
      p.NombreCompleto AS name, ${credentials ? 'u.passwordHash AS passwordHash,' : ''}
      GROUP_CONCAT(DISTINCT CASE WHEN ur.activo = 1 AND r.activo = 1 THEN r.codigo END) AS sourceRoles
      FROM ${users} u LEFT JOIN ${people} p ON p.CodigoPersona = u.CodigoPersona
      LEFT JOIN ${userRoles} ur ON ur.IdUsuario = u.IdUsuarioPortal
      LEFT JOIN ${roles} r ON r.IdRol = ur.IdRol
      WHERE u.usuario = ? GROUP BY u.IdUsuarioPortal LIMIT 1`, [username]);
    return rows[0] ? this.normalize(rows[0]) : null;
  }
  async byId(id) {
    const { users, people, userRoles, roles } = this.tables;
    const [rows] = await this.pool.execute(`SELECT u.IdUsuarioPortal AS id, u.usuario AS username, u.activo AS active,
      u.requiereCambioClave AS changeRequired, u.bloqueadoHasta AS blockedUntil,
      p.NombreCompleto AS name,
      GROUP_CONCAT(DISTINCT CASE WHEN ur.activo = 1 AND r.activo = 1 THEN r.codigo END) AS sourceRoles
      FROM ${users} u LEFT JOIN ${people} p ON p.CodigoPersona = u.CodigoPersona
      LEFT JOIN ${userRoles} ur ON ur.IdUsuario = u.IdUsuarioPortal
      LEFT JOIN ${roles} r ON r.IdRol = ur.IdRol
      WHERE u.IdUsuarioPortal = ? GROUP BY u.IdUsuarioPortal LIMIT 1`, [id]);
    return rows[0] ? this.normalize(rows[0]) : null;
  }
  normalize(row) {
    return {
      id: Number(row.id), username: row.username, name: row.name || row.username,
      active: !!row.active, changeRequired: !!row.changeRequired,
      blocked: !!row.blockedUntil && new Date(row.blockedUntil).getTime() > Date.now(),
      sourceRoles: String(row.sourceRoles || '').split(',').filter(Boolean),
      ...(row.passwordHash ? { passwordHash: row.passwordHash } : {}),
    };
  }
  async close() { await this.pool.end(); }
}

export class Somos3cPersonIdentity {
  constructor(options) {
    this.mode = 'person-email';
    this.pool = mysql.createPool(options.connection);
    this.table = mysql.escapeId(`${options.connection.database}.${options.tables.people}`);
  }
  normalize(row, username, credentials) {
    return {
      id: Number(row.id), username, name: row.name || username,
      active: !!row.active, changeRequired: false, blocked: false, sourceRoles: [],
      ...(credentials ? { passwordHash: row.passwordHash } : {}),
    };
  }
  async lookup(email, { credentials = false } = {}) {
    const [rows] = await this.pool.execute(`SELECT CodigoPersona AS id, NombreCompleto AS name, IsActivo AS active
      ${credentials ? ', Credenciales AS passwordHash' : ''}
      FROM ${this.table} WHERE LOWER(?) IN (LOWER(CorreoElectronico_Institucional),
      LOWER(CorreoElectronico_Personal), LOWER(CorreoElectronico_Alternativo)) LIMIT 2`, [email]);
    if (rows.length > 1) throw new AppError(409, 'Este correo identifica varias cuentas de origen. Usa un correo único.', 'AMBIGUOUS_IDENTITY');
    return rows[0] ? this.normalize(rows[0], email, credentials) : null;
  }
  async byId(id) {
    const [rows] = await this.pool.execute(`SELECT CodigoPersona AS id, NombreCompleto AS name, IsActivo AS active,
      COALESCE(NULLIF(CorreoElectronico_Institucional, ''), NULLIF(CorreoElectronico_Personal, ''),
      CorreoElectronico_Alternativo) AS username FROM ${this.table} WHERE CodigoPersona = ? LIMIT 1`, [id]);
    return rows[0] ? this.normalize(rows[0], rows[0].username, false) : null;
  }
  async close() { await this.pool.end(); }
}
