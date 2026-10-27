import { config, databaseConfig, atomDatabaseConfig, identityDatabaseConfig } from './src/config.js';
import { AtomHistoryStore, DemoStore, MysqlStore, UnconfiguredStore } from './src/store.js';
import { AtomReader } from './src/atom.js';
import { createApp } from './src/app.js';
import { evaluatorFromEnv } from './src/evaluator.js';
import { startDailyScheduler } from './src/daily-scheduler.js';
import { Somos3cIdentity } from './src/identity.js';

const options = databaseConfig();
const atomOptions = config.demo ? null : atomDatabaseConfig();
const identityOptions = config.demo ? null : identityDatabaseConfig();
const store = config.demo ? await new DemoStore(config.demoFile).init() : options ? atomOptions ? new AtomHistoryStore(new MysqlStore(options), new AtomReader(atomOptions, config.timezone)) : new MysqlStore(options) : new UnconfiguredStore();
const evaluator = evaluatorFromEnv();
const identity = identityOptions ? new Somos3cIdentity(identityOptions) : null;
const app = createApp(store, config, evaluator, identity);
const stopScheduler = !config.demo && atomOptions && process.env.OPENAI_EVALUATION_ENABLED === 'true' && evaluator.configured
  ? startDailyScheduler(store, evaluator) : () => {};
const server = app.listen(config.port, config.host, () => {
  console.log(`Pulso API: http://${config.host}:${config.port}/pulso/api/health`);
  console.log(config.demo ? 'Modo demostración: datos sintéticos, guardado local separado.' : atomOptions ? 'Modo real: histórico de Atom en lectura y evaluaciones en Pulso.' : 'Modo real: falta configurar el origen Atom.');
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  stopScheduler();
  server.close(async () => { await Promise.all([store.close(), identity?.close()]); process.exit(0); });
});
