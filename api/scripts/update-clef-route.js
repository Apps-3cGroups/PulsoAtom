import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../src/errors.js';

const maintenanceId = '77f134e8-fdf8-4154-b1f6-485c159b9194';
const reject = code => { throw new AppError(409, 'El estado de Pulso cambió; no se actualizó el perfil de Clef.', code); };
const positive = value => Number.isSafeInteger(value) && value > 0;

// Deliberately narrow: only the unused Clef route may change during the paused
// Gemma maintenance. Unlike the admin form, this never switches the AI policy.
export function planClefRouteUpdate(settings, { activeJobs = 0, activeTasks = 0, activeAttempts = 0,
  now = new Date().toISOString() } = {}) {
  if (!settings || !positive(settings.version)) reject('INVALID_SETTINGS');
  if (activeJobs !== 0 || activeTasks !== 0 || activeAttempts !== 0) reject('EVALUATION_RUNNING');
  const policy = settings.aiPolicy;
  if (policy?.version !== 6 || policy.mode !== 'single' || policy.primaryId !== 'gemma-local'
    || policy.secondaryId != null || policy.fallbackId != null) reject('POLICY_CHANGED');
  if (settings.dailyEnabled !== false || settings.evaluationMaintenance !== maintenanceId) reject('MAINTENANCE_CHANGED');
  const configuration = settings.localModelConfiguration;
  if (!positive(configuration?.version) || !Array.isArray(configuration.profiles)
    || configuration.profiles.length !== 2) reject('INVALID_CONFIGURATION');
  const clef = configuration.profiles.find(p => p.id === 'clef-local');
  const gemma = configuration.profiles.find(p => p.id === 'gemma-local');
  if (!clef || !gemma || gemma.toolKey !== 'gemma' || gemma.model !== 'gemma-4-26b-a4b-it-mlx'
    || gemma.enabled !== true) reject('GEMMA_CONFIGURATION_CHANGED');
  if (clef.toolKey === 'gemma' && clef.model === 'cloudflare_clef') return { settings: structuredClone(settings), changed: false };
  if (clef.toolKey !== 'qwen' || clef.model !== 'clef-flash' || clef.enabled !== true
    || clef.responseFormat !== 'json_schema') reject('CLEF_CONFIGURATION_CHANGED');
  if (!Number.isFinite(Date.parse(now))) reject('INVALID_TIMESTAMP');
  const next = structuredClone(settings);
  const history = next.localModelConfigurationHistory ||= [];
  if (!Array.isArray(history) || history.some(entry => entry.version > configuration.version)) reject('AUDIT_CONFLICT');
  const previous = history.find(entry => entry.version === configuration.version);
  if (previous && !isDeepStrictEqual(previous, configuration)) reject('AUDIT_CONFLICT');
  if (!previous) history.push(structuredClone(configuration));
  const saved = next.localModelConfiguration;
  saved.profiles.find(p => p.id === 'clef-local').toolKey = 'gemma';
  saved.profiles.find(p => p.id === 'clef-local').model = 'cloudflare_clef';
  saved.version++;
  saved.updatedAt = now;
  saved.updatedBy = 'CLI · ajuste Clef solicitado por el usuario';
  saved.updatedById = 'cli-clef-route-update';
  saved.validation = [];
  saved.validationMode = 'operator-configured-pending-preflight';
  saved.reason = 'Nuevo modelo confirmado en catálogo Gateway; inferencia aún pendiente de validación. Política y Gemma conservadas.';
  history.push(structuredClone(saved));
  next.version++;
  return { settings: next, changed: true };
}

const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
export async function updateClefRoute(connection, { apply = false } = {}) {
  await connection.beginTransaction();
  try {
    // Same lock/order used by MysqlStore: concurrent portal writes cannot be lost.
    const [locks] = await connection.query('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE');
    if (locks.length !== 1) reject('APP_LOCK_MISSING');
    const [rows] = await connection.query("SELECT payload FROM portal_settings WHERE id = 'settings' FOR UPDATE");
    if (rows.length !== 1) reject('INVALID_SETTINGS');
    const settings = decode(rows[0].payload);
    const [counts] = await connection.query(`SELECT
      (SELECT COUNT(*) FROM evaluation_jobs WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.status')) IN ('running','pending','queued')) AS activeJobs,
      (SELECT COUNT(*) FROM evaluation_tasks WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.status')) = 'running') AS activeTasks,
      (SELECT COUNT(*) FROM evaluation_attempts WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.status')) = 'running') AS activeAttempts,
      (SELECT COUNT(*) FROM evaluations) AS evaluations,
      (SELECT COUNT(*) FROM operational_refs) AS operationalRefs`);
    const countsBefore = Object.fromEntries(Object.entries(counts[0]).map(([key, value]) => [key, Number(value)]));
    const plan = planClefRouteUpdate(settings, countsBefore);
    if (apply && plan.changed) {
      const [result] = await connection.execute("UPDATE portal_settings SET payload = ? WHERE id = 'settings'", [JSON.stringify(plan.settings)]);
      if (result.affectedRows !== 1) reject('SETTINGS_WRITE_FAILED');
    }
    const expected = apply ? plan.settings : settings;
    const [verified] = await connection.query("SELECT payload FROM portal_settings WHERE id = 'settings'");
    if (!isDeepStrictEqual(decode(verified[0]?.payload), expected)) reject('READBACK_MISMATCH');
    await connection.commit();
    const [persisted] = await connection.query("SELECT payload FROM portal_settings WHERE id = 'settings'");
    if (!isDeepStrictEqual(decode(persisted[0]?.payload), expected)) reject('POST_COMMIT_STATE_CHANGED');
    return { success: true, applied: apply, changed: apply && plan.changed, readbackVerified: true,
      profile: expected.localModelConfiguration.profiles.find(p => p.id === 'clef-local'),
      modelConfigurationVersion: expected.localModelConfiguration.version, settingsVersion: expected.version,
      policy: { version: expected.aiPolicy.version, mode: expected.aiPolicy.mode, primaryId: expected.aiPolicy.primaryId,
        secondaryId: expected.aiPolicy.secondaryId, fallbackId: expected.aiPolicy.fallbackId }, dailyEnabled: expected.dailyEnabled,
      maintenanceId: expected.evaluationMaintenance, counts: countsBefore,
      inferenceValidated: false,
      note: 'Solo configuración de Clef. No se ejecutó IA ni se modificaron evaluaciones, revisiones o programación.' };
  } catch (error) { await connection.rollback(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let connection;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--inspect', '--apply'].includes(args[0])) reject('INVALID_ARGUMENTS');
    const { config, databaseConfig } = await import('../src/config.js');
    const db = databaseConfig();
    if (config.demo || db?.database !== 'dbPulsosAtom') reject('REAL_CONFIGURATION_REQUIRED');
    const { default: mysql } = await import('mysql2/promise');
    const { connectionLimit, ...options } = db;
    connection = await mysql.createConnection(options);
    console.log(JSON.stringify(await updateClefRoute(connection, { apply: args[0] === '--apply' }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ success: false, code: error instanceof AppError ? error.code : 'CLEF_CONFIGURATION_FAILED',
      message: 'No se confirmó el cambio. Consulta el estado antes de reintentar; no se muestran credenciales ni datos de conversaciones.' }));
    process.exitCode = 1;
  } finally { await connection?.end(); }
}
