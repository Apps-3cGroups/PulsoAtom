import { createHash, timingSafeEqual } from 'node:crypto';
import mysql from 'mysql2/promise';

export function matchesSomos3cPassword(storedHash, password) {
  if (!/^[a-f0-9]{128}$/i.test(storedHash || '')) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = createHash('sha512').update(password, 'utf8').digest();
  return timingSafeEqual(expected, actual);
}

export class Somos3cIdentity {
  constructor(options) {
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
