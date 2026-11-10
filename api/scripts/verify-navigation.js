// Read-only equivalence check. Print aggregate counts and field names only.
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { databaseConfig, atomDatabaseConfig, config } from '../src/config.js';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { AtomReader } from '../src/atom.js';
import { filteredConversations, listQuerySchema, summarize } from '../src/domain.js';
import { activeReason } from '../src/one-off-evaluations.js';
import { enableNavigationSummaryCache } from '../src/navigation-cache.js';
const root = process.argv.find(arg => arg.startsWith('--baseline-root='))?.slice('--baseline-root='.length);
if (!root) throw new Error('Provide --baseline-root with the functional checkout.');
const legacy = await import(pathToFileURL(path.resolve(root, 'api/src/domain.js')).href);
const base = new MysqlStore(databaseConfig()), reader = new AtomReader(atomDatabaseConfig(), config.timezone);
const store = new AtomHistoryStore(base, reader), connection = await base.pool.getConnection();
let failures = 0;
try {
 await connection.beginTransaction();
 const [full, source] = await Promise.all([base.load(connection), reader.fetch()]);
 const frozenConnection = new Proxy(connection, { get(target, name) {
  if (['beginTransaction','commit','rollback','release'].includes(name)) return async () => {};
  return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
 }});
 const scoped = Object.create(MysqlStore.prototype);
 scoped.pool = { query: base.pool.query.bind(base.pool), getConnection: async () => frozenConnection };
 for (const scenario of [
  { name: 'all-30', query: { from: '2026-10-12', to: '2026-11-10' } },
  { name: 'hn-pa-30', query: { from: '2026-10-12', to: '2026-11-10', countries: 'HN,PA' } },
  { name: 'active-hn-pa', query: { countries: 'HN,PA' }, activeOnly: true },
 ]) {
  const query = listQuerySchema.parse(scenario.query);
  const overview = await reader.readOverview(query, { activeOnly: !!scenario.activeOnly, settings: full.settings });
  const state = await scoped.readNavigation(overview.conversations.map(c => c.id));
  overview.conversations = await reader.hydrateOverview(overview.conversations, new Set(state.evaluations.map(e => e.conversationId)));
  const originals = new Map(source.conversations.map(c => [c.id,c]));
  const changed = new Set(overview.conversations.filter(c => {
   const before = originals.get(c.id);
   return !before || before.sourceDocumentId !== c.sourceDocumentId || before.sourceDocumentHash !== c.sourceDocumentHash || before.sourceUpdatedAt !== c.sourceUpdatedAt;
  }).map(c=>c.id));
  const expected = store.attach(full, { ...source, conversations: source.conversations.filter(c => !changed.has(c.id)
   && (!query.countries || query.countries.includes(c.country)) && (!scenario.activeOnly || activeReason(c,full.settings))) });
  const actual = store.attach(state, { ...overview, conversations: overview.conversations.filter(c=>!changed.has(c.id)) });
  const before = legacy.filteredConversations(expected, { ...query, countries: undefined });
  enableNavigationSummaryCache(actual, new Map(), scoped.navigationRevisions);
  const after = filteredConversations(actual, query);
  const repeatedMatches = isDeepStrictEqual(after, filteredConversations(actual, query));
  const byId = new Map(after.map(c=>[c.id,c]));const fields = new Set();let different=0;
  for (const row of before) {
   const other=byId.get(row.id);
   if(!isDeepStrictEqual(row,other)) {different++;for(const key of new Set([...Object.keys(row),...Object.keys(other||{})])) if(!isDeepStrictEqual(row[key],other?.[key]))fields.add(key);}
  }
  const matchingMetrics = isDeepStrictEqual(summarize(before),summarize(after));
  const ok = before.length === after.length && !different && matchingMetrics && repeatedMatches;
  if(!ok)failures++;
  console.log(JSON.stringify({scenario:scenario.name,ok,expected:before.length,actual:after.length,different,changedDuringCheck:changed.size,fields:[...fields],matchingMetrics,repeatedMatches}));
 }
 await connection.commit();
} finally {connection.release();await store.close();}
if(failures)process.exitCode=1;
