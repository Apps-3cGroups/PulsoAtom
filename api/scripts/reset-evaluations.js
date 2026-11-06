import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, open } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { apiRoot, databaseConfig } from '../src/config.js';

// Only evaluation-owned tables. Atom, catalog, users, and sessions are never deleted.
const orderedTables = ['evaluation_evidence', 'evaluation_results', 'review_events', 'human_verdicts',
  'evaluation_exposures', 'validation_sessions', 'comparison_samples', 'evaluation_attempts',
  'evaluation_tasks', 'operational_refs', 'evaluation_jobs', 'evaluations'];
const apply = process.argv.includes('--apply');
const restoreIndex = process.argv.indexOf('--restore');
const expectedIndex = process.argv.indexOf('--expected-evaluations');
const expected = expectedIndex < 0 ? null : Number(process.argv[expectedIndex + 1]);
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const digest = text => createHash('sha256').update(text).digest('hex');
const options = databaseConfig();
if (!options) throw new Error('Falta configurar la base propia de Pulso.');
if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) throw new Error('--expected-evaluations debe ser un entero no negativo.');
if (apply && restoreIndex < 0 && expected === null) throw new Error('Indica --expected-evaluations con el conteo auditado antes de limpiar.');
let connection;
try {
  connection = await mysql.createConnection({ ...options, connectTimeout: 15000 });
  await connection.beginTransaction();
  if (apply) await connection.query('SELECT id FROM app_lock WHERE id=1 FOR UPDATE');
  const [tableRows] = await connection.query('SHOW TABLES');
  const available = new Set(tableRows.map(row => Object.values(row)[0]));
  if (orderedTables.some(table => !available.has(table))) throw new Error('Faltan tablas propias de evaluación; completa las migraciones antes de respaldar o limpiar.');
  const tables = orderedTables;
  const [settingsRows] = await connection.query("SELECT payload FROM portal_settings WHERE id='settings'");
  const settings = decode(settingsRows[0].payload);
  const [jobs] = await connection.query('SELECT payload FROM evaluation_jobs');
  if (jobs.some(row => ['running', 'queued', 'pending'].includes(decode(row.payload).status))) throw new Error('Hay una evaluación en curso o en cola. No se modifica el histórico.');
  const data = {}, counts = {};
  for (const table of tables) {
    if (apply && restoreIndex < 0) {
      [data[table]] = await connection.query(`SELECT * FROM ${mysql.escapeId(table)}`);
      counts[table] = data[table].length;
    } else {
      const [rows] = await connection.query(`SELECT COUNT(*) AS total FROM ${mysql.escapeId(table)}`);
      counts[table] = rows[0].total;
    }
  }
  if (restoreIndex >= 0) {
    const filename = path.resolve(process.argv[restoreIndex + 1]);
    const text = await readFile(filename, 'utf8');
    if (digest(text) !== (await readFile(`${filename}.sha256`, 'utf8')).trim()) throw new Error('La copia no coincide con su checksum.');
    const backup = JSON.parse(text);
    if (backup.database !== options.database || backup.format !== 1 || !backup.tables
      || Object.keys(backup.tables).length !== tables.length || tables.some(t => !Array.isArray(backup.tables[t]))) throw new Error('Copia incompatible o incompleta.');
    if (Object.values(counts).some(Boolean)) throw new Error('La restauración exige tablas de evaluación vacías. No se sobrescriben resultados nuevos.');
    if (apply) {
      for (const table of [...tables].reverse()) for (const row of backup.tables[table] || []) {
        const columns = Object.keys(row);
        const values = columns.map(key => row[key] !== null && typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]);
        await connection.execute(`INSERT INTO ${mysql.escapeId(table)} (${columns.map(k=>mysql.escapeId(k)).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`, values);
      }
      await connection.execute("UPDATE portal_settings SET payload=? WHERE id='settings'", [JSON.stringify({ ...backup.settings, dailyEnabled: false, version: settings.version + 1 })]);
      await connection.commit();
    } else await connection.rollback();
    console.log(JSON.stringify({ restored: apply, source: filename, counts: Object.fromEntries(Object.entries(backup.tables).map(([k,v])=>[k,v.length])) }));
  } else {
    if (settings.evaluationMaintenance) throw new Error('Ya existe un reinicio pendiente. Reanuda esa ejecución; no vuelvas a limpiar.');
    if (expected !== null && counts.evaluations !== expected) throw new Error(`El total cambió: esperado ${expected}, actual ${counts.evaluations}. No se limpió nada.`);
    if (!apply) { await connection.rollback(); console.log(JSON.stringify({ dryRun: true, database: options.database, counts,
      settings: { dailyEnabled: settings.dailyEnabled, evaluationMaintenance: settings.evaluationMaintenance,
        policyMode: settings.aiPolicy?.mode, primaryId: settings.aiPolicy?.primaryId, secondaryId: settings.aiPolicy?.secondaryId } }, null, 2)); }
    else {
      const id = randomUUID(), createdAt = new Date().toISOString();
      const backup = { format: 1, id, database: options.database, createdAt, settings, tables: data };
      const directory = path.join(apiRoot, '.data', 'backups');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const filename = path.join(directory, `evaluations-${createdAt.replace(/[:.]/g,'-')}-${id}.json`);
      const text = JSON.stringify(backup);
      await writeFile(filename, text, { mode: 0o600, flag: 'wx' });
      await writeFile(`${filename}.sha256`, digest(text), { mode: 0o600, flag: 'wx' });
      for (const target of [filename, `${filename}.sha256`, directory]) {
        const handle = await open(target, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      }
      if (digest(await readFile(filename, 'utf8')) !== (await readFile(`${filename}.sha256`, 'utf8')).trim()) throw new Error('La copia no pudo verificarse. No se limpió nada.');
      for (const table of tables) await connection.query(`DELETE FROM ${mysql.escapeId(table)}`);
      const next = { ...settings, dailyEnabled: false, includeOpenConversations: true, refreshChangedConversations: true,
        evaluationMaintenance: id, resetPreviousDailyEnabled: settings.dailyEnabled, evaluationResetAt: createdAt, version: settings.version + 1 };
      await connection.execute("UPDATE portal_settings SET payload=? WHERE id='settings'", [JSON.stringify(next)]);
      await connection.commit();
      console.log(JSON.stringify({ reset: true, database: options.database, maintenanceId: id, backup: filename, sha256: digest(text), archivedCounts: counts }, null, 2));
    }
  }
} catch (error) {
  await connection?.rollback().catch(() => {});
  console.error(error.code || error.name, error.code || error instanceof SyntaxError
    ? 'No se pudo completar la operación. Revisa conexión y almacenamiento; no se muestran datos privados.'
    : error.message); process.exitCode = 1;
} finally { await connection?.end(); }
