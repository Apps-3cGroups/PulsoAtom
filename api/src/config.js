import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const apiRoot = fileURLToPath(new URL('../', import.meta.url));
dotenv.config({ path: path.join(apiRoot, '.env'), quiet: true });
const bool = (value, fallback = false) => value === undefined ? fallback : value === 'true';
export const config = {
  demo: bool(process.env.DEMO_MODE, true),
  host: process.env.API_HOST || '127.0.0.1',
  port: Number(process.env.API_PORT || 4001),
  origin: process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:3000',
  sessionHours: Number(process.env.SESSION_HOURS || 8),
  secureCookie: bool(process.env.COOKIE_SECURE),
  timezone: process.env.APP_TIMEZONE || 'America/Tegucigalpa',
  demoFile: path.join(apiRoot, '.data', 'demo-store.json'),
};
export function databaseConfig() {
  if (!process.env.APP_DB_HOST || !process.env.APP_DB_USER || !process.env.APP_DB_NAME) return null;
  return {
    host: process.env.APP_DB_HOST,
    port: Number(process.env.APP_DB_PORT || 3306),
    user: process.env.APP_DB_USER,
    password: process.env.APP_DB_PASSWORD || '',
    database: process.env.APP_DB_NAME,
    charset: 'utf8mb4', timezone: 'Z', connectionLimit: 5,
    connectTimeout: 5000,
    ...(bool(process.env.APP_DB_SSL) ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}

export function atomDatabaseConfig() {
  if (!process.env.ATOM_DB_HOST || !process.env.ATOM_DB_USER || !process.env.ATOM_DB_NAME || !process.env.ATOM_CONVERSATIONS_TABLE || !process.env.ATOM_MESSAGES_TABLE || !process.env.ATOM_COUNTRIES_TABLE) return null;
  if ((process.env.ATOM_DB_ENGINE || 'mysql') !== 'mysql') throw new Error('El conector de Atom requiere MySQL.');
  const table = name => {
    const value = process.env[name];
    if (!value || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?$/.test(value)) throw new Error(`${name} debe ser un nombre de tabla válido.`);
    return value;
  };
  return {
    connection: {
      host: process.env.ATOM_DB_HOST, port: Number(process.env.ATOM_DB_PORT || 3306),
      user: process.env.ATOM_DB_USER, password: process.env.ATOM_DB_PASSWORD || '',
      database: process.env.ATOM_DB_NAME, charset: 'utf8mb4', timezone: 'Z',
      connectionLimit: 3, connectTimeout: 5000,
      ...(bool(process.env.ATOM_DB_SSL) ? { ssl: { rejectUnauthorized: true } } : {}),
    },
    tables: {
      conversations: table('ATOM_CONVERSATIONS_TABLE'),
      events: table('ATOM_MESSAGES_TABLE'),
      countries: table('ATOM_COUNTRIES_TABLE'),
      documents: table('ATOM_DOCUMENTS_TABLE'),
      agents: table('ATOM_AGENTS_TABLE'),
      channels: table('ATOM_CHANNELS_TABLE'),
    },
  };
}

export function identityDatabaseConfig() {
  if (!process.env.IDENTITY_DB_NAME || !process.env.IDENTITY_USERS_TABLE) return null;
  const atom = atomDatabaseConfig();
  if (!atom) return null;
  const identifier = value => {
    if (!/^[A-Za-z0-9_]+$/.test(value || '')) throw new Error('Nombre de tabla o base de identidad inválido.');
    return value;
  };
  return {
    connection: { ...atom.connection, database: identifier(process.env.IDENTITY_DB_NAME) },
    tables: {
      users: identifier(process.env.IDENTITY_USERS_TABLE),
      userRoles: identifier(process.env.IDENTITY_USER_ROLES_TABLE || 'tblUsuarioRoles'),
      roles: identifier(process.env.IDENTITY_ROLES_TABLE || 'tblRoles'),
      people: identifier(process.env.IDENTITY_PEOPLE_TABLE || 'tblPersonas'),
    },
  };
}
