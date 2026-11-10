import { config, databaseConfig, atomDatabaseConfig } from '../src/config.js';
import { DailyLimitStore } from '../src/daily-limit-store.js';
import { prepareDailyLimit, applyDailyLimit } from '../src/daily-limit.js';
import { AppError } from '../src/errors.js';

let store;
try {
  const [operation, target, version, ...extra] = process.argv.slice(2);
  if (extra.length || !['--prepare', '--apply'].includes(operation) || !/^[1-9]\d*$/.test(version || '')
    || !Number.isSafeInteger(Number(version)) || (operation === '--prepare' ? !/^\d{4}-\d{2}-\d{2}$/.test(target || '') : !/^[a-f0-9-]{36}$/.test(target || ''))) {
    throw new AppError(422, 'Usa --prepare YYYY-MM-DD VERSION o --apply UUID VERSION.', 'INVALID_ARGUMENTS');
  }
  if (config.demo || !databaseConfig() || !atomDatabaseConfig()) throw new AppError(409, 'Se requiere el origen real.', 'REAL_MODE_REQUIRED');
  store = new DailyLimitStore(databaseConfig(), atomDatabaseConfig());
  const result = operation === '--prepare'
    ? await prepareDailyLimit(store, { activityDate: target, expectedVersion: Number(version) })
    : await applyDailyLimit(store, { requestId: target, expectedVersion: Number(version) });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : 'No se pudo ajustar el límite diario.');
  process.exitCode = 1;
} finally { await store?.close(); }
