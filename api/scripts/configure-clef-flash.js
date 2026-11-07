import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../src/errors.js';

const maintenanceId = '77f134e8-fdf8-4154-b1f6-485c159b9194';
const reject = code => { throw new AppError(409, 'El estado de Pulso cambió; no se confirmó la configuración de Clef Flash.', code); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const profileView = profile => ({ id: profile.id, label: profile.label, toolKey: profile.toolKey,
  model: profile.model, protocol: profile.protocol || 'chat', responseFormat: profile.responseFormat, enabled: profile.enabled });

// This one-purpose update keeps the paused Gemma policy intact. Batch creation
// is a separate operation; this script cannot start or replace evaluations.
export function planClefFlashConfiguration(settings, { activeJobs = 0, activeTasks = 0, activeAttempts = 0,
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
  const clef = configuration.profiles.find(profile => profile.id === 'clef-local');
  const gemma = configuration.profiles.find(profile => profile.id === 'gemma-local');
  if (!gemma || gemma.toolKey !== 'gemma' || gemma.model !== 'gemma-4-26b-a4b-it-mlx'
    || gemma.enabled !== true || gemma.responseFormat !== 'json_schema'
    || (gemma.protocol !== undefined && gemma.protocol !== 'chat')) reject('GEMMA_CONFIGURATION_CHANGED');
  if (!clef || clef.toolKey !== 'gemma' || clef.enabled !== true || clef.responseFormat !== 'json_schema'
    || !['cloudflare_clef', 'clef-flash'].includes(clef.model)
    || (clef.protocol !== undefined && clef.protocol !== 'chat')) reject('CLEF_CONFIGURATION_CHANGED');
  const history = settings.localModelConfigurationHistory ?? [];
  if (!Array.isArray(history) || history.some(entry => !positive(entry?.version) || entry.version > configuration.version)
    || new Set(history.map(entry => entry.version)).size !== history.length) reject('AUDIT_CONFLICT');
  const previous = history.find(entry => entry.version === configuration.version);
  if (previous && !isDeepStrictEqual(previous, configuration)) reject('AUDIT_CONFLICT');
  // An absent protocol already means chat in the runtime. Do not rewrite an
  // already configured profile merely to materialize that default.
  if (clef.model === 'clef-flash') return { settings: structuredClone(settings), changed: false };
  if (!Number.isFinite(Date.parse(now)) || settings.version === Number.MAX_SAFE_INTEGER
    || configuration.version === Number.MAX_SAFE_INTEGER) reject('INVALID_VERSION_OR_TIMESTAMP');
  const next = structuredClone(settings);
  const nextHistory = next.localModelConfigurationHistory ||= [];
  if (!previous) nextHistory.push(structuredClone(configuration));
  const saved = next.localModelConfiguration;
  Object.assign(saved.profiles.find(profile => profile.id === 'clef-local'), {
    toolKey: 'gemma', model: 'clef-flash', protocol: 'chat', responseFormat: 'json_schema',
  });
  saved.version++;
  saved.updatedAt = now;
  saved.updatedBy = 'CLI · Clef Flash solicitado por el usuario';
  saved.updatedById = 'cli-clef-flash-configuration';
  saved.validation = [];
  saved.validationMode = 'operator-configured';
  saved.reason = 'Selección explícita de Clef Flash por Chat. Se conservan Gemma, política y programación pausada; no se inició un lote.';
  nextHistory.push(structuredClone(saved));
  next.version++;
  return { settings: next, changed: true };
}

export async function configureClefFlash(connection, { apply = false, now } = {}) {
  if (typeof apply !== 'boolean') reject('INVALID_ARGUMENTS');
  await connection.beginTransaction();
  let committed = false;
  try {
    const [locks] = await connection.query('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE');
    if (locks.length !== 1 || Number(locks[0].id) !== 1) reject('APP_LOCK_MISSING');
    const [rows] = await connection.query("SELECT payload FROM portal_settings WHERE id = 'settings' FOR UPDATE");
    if (rows.length !== 1) reject('INVALID_SETTINGS');
    const settings = decode(rows[0].payload);
    const [counts] = await connection.query(`SELECT
      (SELECT COUNT(*) FROM evaluation_jobs WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.status')) IN ('running','pending','queued')) AS activeJobs,
      (SELECT COUNT(*) FROM evaluation_tasks WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.status')) = 'running') AS activeTasks,
      (SELECT COUNT(*) FROM evaluation_attempts WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.status')) = 'running') AS activeAttempts,
      (SELECT COUNT(*) FROM evaluations) AS evaluations,
      (SELECT COUNT(*) FROM operational_refs) AS operationalRefs`);
    const countKeys = ['activeJobs', 'activeTasks', 'activeAttempts', 'evaluations', 'operationalRefs'];
    if (counts.length !== 1) reject('INVALID_COUNTS');
    const countsBefore = Object.fromEntries(countKeys.map(key => [key, Number(counts[0][key])]));
    if (Object.values(countsBefore).some(value => !Number.isSafeInteger(value) || value < 0)) reject('INVALID_COUNTS');
    const plan = planClefFlashConfiguration(settings, { ...countsBefore, ...(now ? { now } : {}) });
    if (apply && plan.changed) {
      const [written] = await connection.execute("UPDATE portal_settings SET payload = ? WHERE id = 'settings'", [JSON.stringify(plan.settings)]);
      if (written.affectedRows !== 1) reject('SETTINGS_WRITE_FAILED');
    }
    const expected = apply ? plan.settings : settings;
    const [verified] = await connection.query("SELECT payload FROM portal_settings WHERE id = 'settings'");
    if (verified.length !== 1 || !isDeepStrictEqual(decode(verified[0].payload), expected)) reject('READBACK_MISMATCH');
    await connection.commit(); committed = true;
    const [persisted] = await connection.query("SELECT payload FROM portal_settings WHERE id = 'settings'");
    if (persisted.length !== 1 || !isDeepStrictEqual(decode(persisted[0].payload), expected)) reject('POST_COMMIT_STATE_CHANGED');
    return { success: true, applied: apply, changed: apply && plan.changed, wouldChange: plan.changed, readbackVerified: true,
      profile: profileView(expected.localModelConfiguration.profiles.find(profile => profile.id === 'clef-local')),
      plannedProfile: profileView(plan.settings.localModelConfiguration.profiles.find(profile => profile.id === 'clef-local')),
      modelConfigurationVersion: expected.localModelConfiguration.version, settingsVersion: expected.version,
      policy: { version: expected.aiPolicy.version, mode: expected.aiPolicy.mode, primaryId: expected.aiPolicy.primaryId,
        secondaryId: expected.aiPolicy.secondaryId, fallbackId: expected.aiPolicy.fallbackId },
      dailyEnabled: expected.dailyEnabled, maintenanceId: expected.evaluationMaintenance, counts: countsBefore,
      note: 'Solo configuración de Clef. Sin inferencias ni cambios en evaluaciones, revisiones o programación.' };
  } catch (error) { if (!committed) await connection.rollback(); throw error; }
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
    console.log(JSON.stringify(await configureClefFlash(connection, { apply: args[0] === '--apply' }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ success: false, code: error instanceof AppError ? error.code : 'CLEF_CONFIGURATION_FAILED',
      message: 'No se confirmó el cambio. Consulta el estado antes de reintentar.' }));
    process.exitCode = 1;
  } finally { await connection?.end().catch(() => {}); }
}
