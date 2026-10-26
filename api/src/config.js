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
