import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { COMPLETION_ID, assertCompletionPlan } from '../src/tuesday-wednesday-completion.js';
import { prepareThursdayHandoff, inspectThursdayHandoff, THURSDAY_ACTIVITY, THURSDAY_INGESTION } from '../src/thursday-handoff.js';
import { AppError } from '../src/errors.js';

const manifestFile = `/var/www/nodeapps/PulsoAtom/api/.data/incident-completion/${COMPLETION_ID}/manifest.json`;
export function parseThursdayArguments(args) {
  if (args.length === 1 && args[0] === '--inspect') return { mode: 'inspect' };
  if (args.length === 7 && args[0] === '--prepare' && args[1] === '--expected-version'
    && /^[1-9]\d*$/.test(args[2]) && Number.isSafeInteger(Number(args[2]))
    && args[3] === '--expected-scope-hash' && /^[a-f0-9]{64}$/.test(args[4])
    && args[5] === '--concurrency' && ['1', '2'].includes(args[6])) {
    return { mode: 'prepare', expectedVersion: Number(args[2]), expectedScopeHash: args[4], concurrency: Number(args[6]) };
  }
  throw new AppError(422, 'Usa --inspect o --prepare --expected-version N --expected-scope-hash HASH --concurrency 1|2.', 'INVALID_ARGUMENTS');
}
export async function main(args) {
  const options = parseThursdayArguments(args);
  const { config, databaseConfig, atomDatabaseConfig } = await import('../src/config.js');
  const { MysqlStore, AtomHistoryStore } = await import('../src/store.js');
  const { AtomReader } = await import('../src/atom.js');
  const { registryFromEnv } = await import('../src/model-registry.js');
  const db = databaseConfig(), atom = atomDatabaseConfig();
  if (config.demo || db?.database !== 'dbPulsosAtom' || !atom) throw new AppError(409, 'Se requiere la configuración real de Pulso y Atom.', 'REAL_MODE_REQUIRED');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.id !== COMPLETION_ID) throw new AppError(409, 'El manifiesto no corresponde a la recuperación esperada.', 'INVALID_COMPLETION_MANIFEST');
  assertCompletionPlan(manifest.plan);
  const base = new MysqlStore(db), reader = new AtomReader(atom, config.timezone), store = new AtomHistoryStore(base, reader);
  try {
    const registry = registryFromEnv();
    if (options.mode === 'prepare') return await prepareThursdayHandoff(store, registry, manifest.plan, options);
    const state = await base.read();
    const metadata = await reader.readOverview({ from: THURSDAY_ACTIVITY, countries: ['HN', 'PA'] }, { metadataOnly: true });
    const ids = metadata.conversations.map(c => c.id), source = { ...metadata, conversations: [] };
    for (let offset = 0; offset < ids.length; offset += 300) {
      const page = await reader.read({ conversationIds: ids.slice(offset, offset + 300) });
      source.conversations.push(...page.conversations);
    }
    const ingestion = await store.readIngestionSnapshot(THURSDAY_INGESTION);
    return inspectThursdayHandoff(store.attach(state, source), registry, manifest.plan, { ingestion });
  } finally { await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(result => {
  console.log(JSON.stringify(result, null, 2));
}).catch(error => {
  console.error(JSON.stringify({ success: false, errorCode: /^[A-Z_]{3,80}$/.test(error?.code || '') ? error.code : 'HANDOFF_FAILED' }));
  process.exitCode = 1;
});
