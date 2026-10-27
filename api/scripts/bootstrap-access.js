import { databaseConfig, identityDatabaseConfig } from '../src/config.js';
import { MysqlStore } from '../src/store.js';
import { Somos3cIdentity } from '../src/identity.js';

const username = process.argv[2]?.trim();
if (!username || process.argv.length !== 3) throw new Error('Uso: npm run access:bootstrap -- <usuario exacto de Somos3C>');
const appOptions = databaseConfig();
const identityOptions = identityDatabaseConfig();
if (!appOptions || !identityOptions) throw new Error('Configura APP_DB_*, ATOM_DB_* e IDENTITY_* en api/.env.');
const store = new MysqlStore(appOptions);
const identity = new Somos3cIdentity(identityOptions);
try {
  const source = await identity.lookup(username);
  if (!source?.active || source.blocked || source.changeRequired) throw new Error('La cuenta de origen no está lista para ingresar a Pulso. Verifica su estado y cambio de clave en Somos3C.');
  await store.transaction(state => {
    if (state.users.some(user => user.role === 'admin' && user.active)) throw new Error('Pulso ya tiene un administrador. Usa la pantalla Accesos para otorgar permisos.');
    state.users.push({
      id: `somos3c:${source.id}`, externalId: source.id, externalGrant: true,
      email: `somos3c-${source.id}@pulso.local`, name: source.name,
      role: 'admin', active: true, createdAt: new Date().toISOString(),
    });
  });
  console.log('Acceso administrativo inicial guardado en Pulso para el usuario indicado.');
} finally {
  await Promise.all([store.close(), identity.close()]);
}
