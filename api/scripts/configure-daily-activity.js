import { config, databaseConfig } from '../src/config.js';
import { MysqlStore } from '../src/store.js';
import { registryFromEnv } from '../src/model-registry.js';
import { discoverLocalModels } from '../src/services/gatewayDiscovery.js';
import { configureDailyActivity, inspectDailyActivity, requestYesterdayActivity, DAILY_MODELS } from '../src/configure-daily-activity.js';
import { AppError } from '../src/errors.js';

let store;
try {
  const args = process.argv.slice(2);
  const enable = args.length === 5 && args[0] === '--enable' && args[1] === '--start-date' && args[3] === '--expected-version'
    && /^[1-9]\d*$/.test(args[4]) && Number.isSafeInteger(Number(args[4]));
  const runYesterday = args.length === 5 && args[0] === '--run-yesterday' && args[1] === '--date' && args[3] === '--expected-version'
    && /^[1-9]\d*$/.test(args[4]) && Number.isSafeInteger(Number(args[4]));
  if (!enable && !runYesterday && !(args.length === 1 && args[0] === '--inspect')) throw new AppError(422, 'Usa --inspect, --enable --start-date YYYY-MM-DD --expected-version N o --run-yesterday --date YYYY-MM-DD --expected-version N.', 'INVALID_ARGUMENTS');
  if (config.demo || !databaseConfig()) throw new AppError(409, 'Se requiere la configuración real del servidor.', 'REAL_MODE_REQUIRED');
  store = new MysqlStore(databaseConfig());
  const registry = registryFromEnv(), state = await store.read(), bound = registry.forState(state);
  const discovery = [];
  for (const id of DAILY_MODELS) {
    const profile = bound.resolve(id);
    if (profile.evaluator.protocol === 'systemone') await profile.evaluator.discovery();
    else {
      const catalog = await discoverLocalModels({ toolKey: profile.evaluator.toolKey });
      if (!catalog.models.includes(profile.model)) throw new AppError(409, 'Un modelo guardado no está disponible en Gateway.', 'MODEL_UNAVAILABLE');
    }
    discovery.push({ id, model: profile.model, available: true });
  }
  const result = enable ? await configureDailyActivity(store, registry, { startDate: args[2], expectedVersion: Number(args[4]) })
    : runYesterday ? await requestYesterdayActivity(store, registry, { activityDate: args[2], expectedVersion: Number(args[4]) })
      : inspectDailyActivity(state, registry);
  console.log(JSON.stringify({ ...result, discovery, note: runYesterday
    ? 'Revisión de ayer solicitada. El evaluador del servidor la iniciará en su siguiente comprobación, sin cambiar el horario diario.'
    : 'Se consultó disponibilidad; no se ejecutó ninguna evaluación.' }, null, 2));
} catch (error) {
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : 'No se pudo verificar o guardar la programación diaria.');
  process.exitCode = 1;
} finally { await store?.close(); }
