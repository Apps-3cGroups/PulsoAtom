import { config, databaseConfig } from './src/config.js';
import { DemoStore, MysqlStore, UnconfiguredStore } from './src/store.js';
import { createApp } from './src/app.js';

const options = databaseConfig();
const store = config.demo ? await new DemoStore(config.demoFile).init() : options ? new MysqlStore(options) : new UnconfiguredStore();
const app = createApp(store, config);
const server = app.listen(config.port, config.host, () => {
  console.log(`Pulso API: http://${config.host}:${config.port}/pulso/api/health`);
  console.log(config.demo ? 'Modo demostración: datos sintéticos, guardado local separado.' : 'Modo real: MySQL. La evaluación está pendiente de integración.');
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close(async () => { await store.close(); process.exit(0); });
});
