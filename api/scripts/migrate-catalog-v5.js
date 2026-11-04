import { databaseConfig } from '../src/config.js';
import { MysqlStore } from '../src/store.js';
import { migrateCatalogV5 } from '../src/catalog-v5.js';

const options = databaseConfig();
if (!options) throw new Error('Configura APP_DB_* antes de migrar el catálogo.');
const store = new MysqlStore(options);
try {
  const changed = await store.transaction(state => migrateCatalogV5(state));
  console.log(changed ? 'Catálogo v5 aplicado. Se conservaron evaluaciones y revisiones históricas.' : 'El catálogo v5 ya estaba aplicado.');
} finally { await store.close(); }
