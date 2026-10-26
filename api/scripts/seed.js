import { databaseConfig } from '../src/config.js';
import { MysqlStore } from '../src/store.js';
import { createState } from '../src/data/seed.js';

const options = databaseConfig();
if (!options) throw new Error('Configura APP_DB_* en api/.env antes de cargar el catálogo.');
const store = new MysqlStore(options);
try {
  const added = await store.transaction(state => {
    const initial = createState(false);
    let count = 0;
    for (const item of initial.catalog) if (!state.catalog.some(v => v.id === item.id)) {
      state.catalog.push(item);
      state.catalogVersions.push(initial.catalogVersions.find(v => v.itemId === item.id));
      count++;
    }
    return count;
  });
  console.log(`${added} variables añadidas. Los cambios existentes se conservaron. No se insertaron conversaciones demo.`);
} finally { await store.close(); }
