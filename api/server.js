import { config, databaseConfig, atomDatabaseConfig, identityDatabaseConfig } from './src/config.js';
import { AtomHistoryStore, DemoStore, MysqlStore, UnconfiguredStore } from './src/store.js';
import { AtomReader } from './src/atom.js';
import { createApp } from './src/app.js';
import { registryFromEnv } from './src/model-registry.js';
import { startDailyScheduler } from './src/daily-scheduler.js';
import { Somos3cIdentity, Somos3cPersonIdentity } from './src/identity.js';
import { migrateCatalogV5 } from './src/catalog-v5.js';

// CAMBIAR AQUÍ LA RUTA BASE DEL PORTAL: BASE_PATH en api/.env.
const options = databaseConfig();
const atomOptions = config.demo ? null : atomDatabaseConfig();
const identityOptions = config.demo ? null : identityDatabaseConfig();
const store = config.demo ? await new DemoStore(config.demoFile).init() : options ? atomOptions ? new AtomHistoryStore(new MysqlStore(options), new AtomReader(atomOptions, config.timezone)) : new MysqlStore(options) : new UnconfiguredStore();
// Apply the data revision before starting any scheduler or accepting evaluations.
// An unconfigured instance must retain its existing configuration-required health response.
if (!config.demo && options) await store.transaction(state => migrateCatalogV5(state));
const evaluator = registryFromEnv({ demo: config.demo });
const identity = identityOptions ? identityOptions.mode === 'person-email' ? new Somos3cPersonIdentity(identityOptions) : new Somos3cIdentity(identityOptions) : null;
const app = createApp(store, config, evaluator, identity);
// Configuration can be completed in the portal after boot. Each tick checks the
// saved policy before doing any work; no process restart is needed after edits.
const stopScheduler = !config.demo && atomOptions
  ? startDailyScheduler(store, evaluator) : () => {};
const server = app.listen(config.port, config.host, () => {
  console.log(`Pulso API: http://${config.host}:${config.port}${config.basePath}/api/health`);
  console.log(config.demo ? 'Modo demostración: datos sintéticos, guardado local separado.' : atomOptions ? 'Modo real: histórico de Atom en lectura y evaluaciones en Pulso.' : 'Modo real: falta configurar el origen Atom.');
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  stopScheduler();
  server.close(async () => { await Promise.all([store.close(), identity?.close()]); process.exit(0); });
});
