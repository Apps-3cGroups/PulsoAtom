import { config, databaseConfig } from '../src/config.js';
import { MysqlStore } from '../src/store.js';
import { registryFromEnv } from '../src/model-registry.js';
import { AppError } from '../src/errors.js';
import { inspectGemmaRenewal, prepareGemmaRenewal } from '../src/gemma-renewal-preparation.js';

function parse(args) {
  let mode = 'inspect', chosen = false, expectedPolicyVersion;
  for (let i = 0; i < args.length; i++) {
    if (['--inspect', '--prepare'].includes(args[i])) {
      if (chosen) throw new AppError(422, 'Usa solo --inspect o --prepare.', 'INVALID_ARGUMENTS');
      mode = args[i].slice(2); chosen = true;
    } else if (args[i] === '--expected-policy-version') {
      const value = args[++i];
      if (expectedPolicyVersion !== undefined || !/^[1-9]\d*$/.test(value || '') || !Number.isSafeInteger(Number(value))) throw new AppError(422, 'La versión esperada debe ser un entero positivo.', 'INVALID_ARGUMENTS');
      expectedPolicyVersion = Number(value);
    } else throw new AppError(422, 'Usa --inspect o --prepare --expected-policy-version N.', 'INVALID_ARGUMENTS');
  }
  if (mode === 'prepare' && expectedPolicyVersion === undefined) throw new AppError(422, '--prepare requiere --expected-policy-version.', 'EXPECTED_VERSION_REQUIRED');
  if (mode === 'inspect' && expectedPolicyVersion !== undefined) throw new AppError(422, '--expected-policy-version requiere --prepare.', 'INVALID_ARGUMENTS');
  return { mode, expectedPolicyVersion };
}

let store;
try {
  const options = parse(process.argv.slice(2)), database = databaseConfig();
  if (config.demo || !database) throw new AppError(409, 'Configura la base real de Pulso antes de preparar la renovación.', 'REAL_MODE_REQUIRED');
  store = new MysqlStore(database);
  const registry = registryFromEnv();
  const result = options.mode === 'prepare'
    ? await prepareGemmaRenewal(store, registry, options)
    : inspectGemmaRenewal(await store.read(), registry);
  console.log(JSON.stringify({ event: options.mode, ...result,
    note: 'No se borraron evaluaciones ni se ejecutó IA. Atom no se consulta ni modifica.' }, null, 2));
} catch (error) {
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : 'No se pudo completar la preparación. Revisa configuración y conexión; no se muestran datos privados.');
  process.exitCode = 1;
} finally { await store?.close(); }
