import test from 'node:test';
import assert from 'node:assert/strict';
import { localMidnight } from '../src/overview-query.js';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { AtomReader, mapAtomConversation } from '../src/atom.js';
import { sourceFingerprint } from '../src/evaluation-context.js';
import { createState } from '../src/data/seed.js';

test('SQL date boundaries respect Honduras and timezone DST', () => {
 assert.equal(localMidnight('2026-11-13', 'America/Tegucigalpa').toISOString(), '2026-11-13T06:00:00.000Z');
 assert.equal(localMidnight('2026-07-01', 'America/New_York').toISOString(), '2026-07-01T04:00:00.000Z');
});
test('scoped portal reads use indexes and retain related jobs, reviews and complement samples only', async () => {
 const calls=[];
 const rows={evaluations:[{id:'e',conversationId:'c',jobId:'j'}],evaluation_tasks:[{id:'t',conversationId:'c',jobId:'j'}],evaluation_jobs:[{id:'j'}],comparison_samples:[{id:'j'}]};
 const connection={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{},
 query:async(sql,values)=>{calls.push(sql);if(!values)return[[]]; const table=sql.match(/FROM (\w+)/)?.[1]; return [(rows[table]||[]).map((payload,i)=>({id:payload.id,revision:'v1',sequence_id:i,payload}))];}};
 const store=Object.create(MysqlStore.prototype);store.navigationColumns=new Set(['evaluations','evaluation_tasks']);store.navigationColumnsAt=Date.now();store.pool={getConnection:async()=>connection};
 const state=await store.readNavigation(['c']);
 assert.equal(state.evaluations.length,1);assert.equal(state.tasks.length,1);assert.equal(state.jobs.length,1);assert.equal(state.comparisons.length,1);
 assert.ok(calls.some(sql=>sql.includes('evaluations WHERE conversation_key IN')));
 assert.ok(calls.every(sql=>!sql.includes('evaluation_attempts')&&!sql.includes('evaluation_exposures')&&!sql.includes('validation_sessions')));
 const coldCalls=calls.length;await store.readNavigation(['c']);
 assert.equal(calls.slice(coldCalls).filter(sql=>/^SELECT id, (payload|JSON_REMOVE)/.test(sql)&&!sql.includes('portal_settings')).length,0);
});
test('auth only reads the requested session and user; exposures use idempotent direct writes', async () => {
 const calls=[];const store=Object.create(MysqlStore.prototype);
 store.pool={execute:async(sql,values)=>{calls.push([sql,values]);return [[{payload:sql.includes('sessions')?{id:'session',userId:'u'}:{id:'u'}}]];}};
 const auth=await store.readAuthentication('session');assert.equal(auth.users[0].id,'u');assert.equal(calls.length,2);
 await store.recordExposures([{id:'exposure',userId:'u'}]);assert.ok(calls.at(-1)[0].startsWith('INSERT IGNORE INTO evaluation_exposures'));
});
test('overview caches only evaluated transcripts, invalidates document and actor context, preserves source hashes', async () => {
 const reader=Object.create(AtomReader.prototype);reader.overviewCache=new Map();let fetched=0;
 const row={IdConversacion:1,IdDocumentoVigente:10,DocumentoSha256:'a'.repeat(64),ClienteNombre:'Client',AsesorNombre:'Agent',IdAsesorActual:3,FechaInicioUtc:'2026-11-10T12:00:00Z',FechaUltimaActividadUtc:'2026-11-10T12:01:00Z'};
 const events=[{IdEvento:1,TipoOrigen:'text',RolEmisor:'CLIENTE',Texto:'Hello',FechaHoraUtc:'2026-11-10T12:00:00Z'}];
 const map=()=>mapAtomConversation(row,events,{code:'HN',name:'Honduras'},'America/Tegucigalpa');
 reader.fetch=async({conversationIds})=>{fetched++;assert.deepEqual(conversationIds,['1']);return{conversations:[map()]};};
 const pending={...map(),id:'2',messages:[]};
 const first=await reader.hydrateOverview([{...map(),messages:[]},pending],new Set(['1']));
 assert.equal(fetched,1);assert.equal(first[1].messages.length,0);assert.equal(sourceFingerprint(first[0]),sourceFingerprint(map()));
 await reader.hydrateOverview([{...map(),messages:[]}],new Set(['1']));assert.equal(fetched,1);
 row.AsesorNombre='Other';await reader.hydrateOverview([{...map(),messages:[]}],new Set(['1']));assert.equal(fetched,2);
 row.DocumentoSha256='b'.repeat(64);await reader.hydrateOverview([{...map(),messages:[]}],new Set(['1']));assert.equal(fetched,3);
 const store=new AtomHistoryStore({},{});const state=createState(false);const attached=store.attach(state,{conversations:first,countries:[],loadedAt:'now'});
 assert.equal(sourceFingerprint(attached.conversations[0]),sourceFingerprint(first[0]));
});
test('uncached ordinary source objects still detect in-place changes',()=>{
 const c={id:'1',messages:[{id:'m',actor:'cliente',text:'before'}]};const before=sourceFingerprint(c);c.messages[0].text='after';assert.notEqual(sourceFingerprint(c),before);
});

test('navigation cache checks revisions on every read, including updates with the same ID', async () => {
 let revision='one', value=1, fetches=0;const statements=[];
 const connection={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{},query:async(sql)=>{
   statements.push(sql);
   if(sql.includes('FROM evaluations')&&sql.includes('SHA2'))return[[{id:'e',sequence_id:1,revision}]];
   if(sql.startsWith('SELECT id, payload AS payload FROM evaluations')){fetches++;return[[{id:'e',payload:{id:'e',conversationId:'c',results:[{value}]}}]];}
   return[[]];
 }};
 const store=Object.create(MysqlStore.prototype);store.pool={getConnection:async()=>connection,query:async()=>[[]]};
 assert.equal((await store.readNavigation(['c'])).evaluations[0].results[0].value,1);
 await store.readNavigation(['c']);assert.equal(fetches,1);
 revision='two';value=0;
 assert.equal((await store.readNavigation(['c'])).evaluations[0].results[0].value,0);assert.equal(fetches,2);
 assert.ok(statements.some(sql=>sql.includes("WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.conversationId'))")));
});

test('scheduler and health retain persisted model policy without loading evaluator history', async () => {
 const store=Object.create(MysqlStore.prototype);const calls=[];
 store.pool={query:async(sql)=>{calls.push(sql);return[sql.includes('model_policies')?[{payload:{id:'policy',mode:'dual'}}]:[]];}};
 const state=await store.readSchedulerState();assert.equal(state.modelPolicies[0].id,'policy');
 assert.ok(calls.every(sql=>!sql.includes('evaluation_tasks')&&!sql.includes('FROM evaluations')&&!sql.includes('evaluation_attempts')));
});
