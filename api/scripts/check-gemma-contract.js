import { pathToFileURL } from 'node:url';
import { checkGemmaContract } from '../src/gemma-contract-check.js';
import { digest } from '../src/evaluation-context.js';

const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
// No MysqlStore/AtomHistoryStore: this command reads only checklist and settings.
export async function readGemmaContractState(connection) {
  await connection.query('START TRANSACTION READ ONLY');
  try {
    const [catalog] = await connection.query('SELECT payload FROM catalog_items ORDER BY sequence_id');
    const [settings] = await connection.query("SELECT payload FROM portal_settings WHERE id = 'settings'");
    if (settings.length !== 1) throw new Error('No se encontró la configuración de Pulso.');
    const state = { catalog: catalog.map(row => decode(row.payload)), settings: decode(settings[0].payload) };
    await connection.commit();
    return state;
  } catch (error) { await connection.rollback(); throw error; }
}

export async function runGemmaContractCheck({ connection, registry, redactions = [] }) {
  const before = await readGemmaContractState(connection);
  const result = await checkGemmaContract({ registry, state: before, redactions });
  const after = await readGemmaContractState(connection);
  const configurationUnchanged = digest(before) === digest(after);
  return { ...result, configurationUnchanged, success: result.success && configurationUnchanged };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Uso: node scripts/check-gemma-contract.js\nLee catálogo/configuración de Pulso y prueba Gemma con mensajes sintéticos; máximo un reintento de pendientes. No consulta Atom, no cambia configuración ni guarda evaluaciones.');
    return;
  }
  if (args.length) throw new Error('INVALID_ARGUMENTS');
  const { config, databaseConfig } = await import('../src/config.js');
  const { registryFromEnv } = await import('../src/model-registry.js');
  const { default: mysql } = await import('mysql2/promise');
  const db = databaseConfig();
  if (config.demo || !db) throw new Error('REAL_CONFIGURATION_REQUIRED');
  const { connectionLimit, ...connectionOptions } = db;
  const connection = await mysql.createConnection(connectionOptions);
  try {
    const result = await runGemmaContractCheck({ connection, registry: registryFromEnv(),
      redactions: [process.env.AGENT_SHARED_TOKEN, process.env.GATEWAY_BASE_URL].filter(Boolean) });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.success ? 0 : 1;
  } finally { await connection.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error('No se pudo completar la comprobación sintética de Gemma. Verifica los argumentos, el acceso de lectura y su configuración. No se modificó la base.');
    process.exitCode = 2;
  });
}
