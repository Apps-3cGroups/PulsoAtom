import { performance } from 'node:perf_hooks';
import { databaseConfig, atomDatabaseConfig, config } from '../src/config.js';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { AtomReader } from '../src/atom.js';
import { filteredConversations, summarize, listQuerySchema } from '../src/domain.js';
import { activeReason } from '../src/one-off-evaluations.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const legacy = process.argv.includes('--baseline');
const paired = process.argv.includes('--paired');
const iterations = Number(process.argv.find(arg => arg.startsWith('--iterations='))?.split('=')[1] || 6);
if (!Number.isInteger(iterations) || iterations < 2 || iterations > 50) throw new Error('Use 2–50 iterations.');
const store = new AtomHistoryStore(new MysqlStore(databaseConfig()), new AtomReader(atomDatabaseConfig(), config.timezone));
let baseline = store;
const baselineRoot = process.argv.find(arg => arg.startsWith('--baseline-root='))?.slice('--baseline-root='.length);
if (baselineRoot) {
 const load = file => import(pathToFileURL(path.resolve(baselineRoot, 'api/src', file)).href);
 const [storage, settings] = await Promise.all([load('store.js'), load('config.js')]);
 // Same source mapper/filters, legacy full-state/full-transcript read path and
 // connection configuration. This isolates the query optimization itself.
 baseline = new AtomHistoryStore(new storage.MysqlStore(settings.databaseConfig()), new AtomReader(settings.atomDatabaseConfig(), settings.config.timezone));
}
if (process.argv.includes('--trace')) {
 for (const [target, name] of [[store.base, 'readNavigation'], [store.base, 'read'], [store.reader, 'readOverview'], [store.reader, 'hydrateOverview'], [store.reader, 'read']]) {
  const original = target[name].bind(target);
  target[name] = async (...args) => { const start = performance.now(); const result = await original(...args); console.log(JSON.stringify({ phase: name, elapsedMs: Math.round(performance.now() - start) })); return result; };
 }
}
const p95 = values => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
try {
 const scenarios = [
  { name: 'summary-30-all', query: listQuerySchema.parse({ from: '2026-10-12', to: '2026-11-10' }) },
  { name: 'summary-30-hn-pa', query: listQuerySchema.parse({ from: '2026-10-12', to: '2026-11-10', countries: 'HN,PA' }) },
  { name: 'active-hn-pa', query: listQuerySchema.parse({ countries: 'HN,PA' }), activeOnly: true },
 ];
 for (const kind of paired ? ['baseline', 'optimized'] : [legacy ? 'baseline' : 'optimized']) for(const scenario of scenarios) {
  const samples=[];let count=0, bytes=0;
  for(let i=0;i<iterations;i++) {
   const start=performance.now();
   const state=kind==='baseline'?await baseline.readWithConversations():await store.readForNavigation(scenario.query,{activeOnly:!!scenario.activeOnly});
   if(scenario.activeOnly) state.conversations=state.conversations.filter(c=>activeReason(c,state.settings));
   const conversations=filteredConversations(state,scenario.query);
   const serialized=JSON.stringify({metrics:summarize(conversations),conversations:scenario.activeOnly?conversations.slice(0,12):conversations});
   const elapsed=performance.now()-start;count=conversations.length;bytes=Buffer.byteLength(serialized);
   if(i) samples.push(elapsed);
   console.log(JSON.stringify({kind,scenario:scenario.name,iteration:i,cold:i===0,elapsedMs:Math.round(elapsed),count}));
  }
  console.log(JSON.stringify({result:true,kind,scenario:scenario.name,p95Ms:Math.round(p95(samples)),samplesMs:samples.map(Math.round),count,bytes}));
 }
} finally {await store.close();if(baseline!==store)await baseline.close();}
