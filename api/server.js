import { config, databaseConfig, atomDatabaseConfig } from './src/config.js';
import { AtomHistoryStore, DemoStore, MysqlStore, UnconfiguredStore } from './src/store.js';
import { AtomReader } from './src/atom.js';
import { createApp } from './src/app.js';

const options = databaseConfig();
const atomOptions = config.demo ? null : atomDatabaseConfig();
const store = config.demo ? await new DemoStore(config.demoFile).init() : options ? atomOptions ? new AtomHistoryStore(new MysqlStore(options), new AtomReader(atomOptions, config.timezone)) : new MysqlStore(options) : new UnconfiguredStore();
const app = createApp(store, config);
const server = app.listen(config.port, config.host, () => {
  console.log(`Pulso API: http://${config.host}:${config.port}/pulso/api/health`);
  console.log(config.demo ? 'Modo demostración: datos sintéticos, guardado local separado.' : atomOptions ? 'Modo real: histórico de Atom en lectura. La evaluación está pendiente de integración.' : 'Modo real: falta configurar el origen Atom. La evaluación está pendiente de integración.');
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close(async () => { await store.close(); process.exit(0); });
});
