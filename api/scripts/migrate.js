import { readdir, readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { databaseConfig } from '../src/config.js';

const options = databaseConfig();
if (!options) throw new Error('Completa APP_DB_HOST, APP_DB_NAME y APP_DB_USER en api/.env.');
const connection = await mysql.createConnection(options);
try {
  await connection.query('CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(160) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    const [existing] = await connection.execute('SELECT name FROM schema_migrations WHERE name = ?', [name]);
    if (existing.length) { console.log(`Ya aplicada: ${name}`); continue; }
    const sql = await readFile(new URL(name, directory), 'utf8');
    // El DDL de MySQL hace commit implícito. Cada sentencia es repetible para recuperarse de una interrupción.
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await connection.query(statement);
    await connection.execute('INSERT INTO schema_migrations (name) VALUES (?)', [name]);
    console.log(`Aplicada: ${name}`);
  }
} finally { await connection.end(); }
