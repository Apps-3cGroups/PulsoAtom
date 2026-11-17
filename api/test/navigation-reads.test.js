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

test('derived summary cache invalidates reviews, model output and source and keeps URL fields out', async () => {
 const {enableNavigationSummaryCache} = await import('../src/navigation-cache.js');
 const {conversationView,filteredConversations} = await import('../src/domain.js');
 const state=createState(true), cache=new Map();const c=state.conversations[0];
 const check=()=>{enableNavigationSummaryCache(state,cache);return conversationView(state,c);};
 const first=check();const match=check();assert.deepEqual(match,first);
 filteredConversations(state,{q:c.client.name,dateBasis:'activity'});
 assert.equal(check().excerpt,undefined);assert.equal(check().displayDate,undefined);
 const evaluation=state.evaluations.find(e=>e.id===c.evaluationId);evaluation.sourceHash=sourceFingerprint(c);
 assert.equal(check().sourceChanged,false);c.messages[0].text+=' change';assert.equal(check().sourceChanged,true);
 const variable=evaluation.results.find(r=>state.catalogVersions.some(v=>v.itemId===r.variableId&&v.version===1&&v.snapshot.type==='Flag')).variableId;
 state.reviews.push({id:'review',conversationId:c.id,evaluationId:evaluation.id,variableId:variable,action:'levantar',createdAt:'2026-11-10T12:00:00Z'});
 assert.ok(check().human>first.human);
 const result=evaluation.results.find(r=>r.variableId===variable);result.error={code:'AI_INCOMPLETE'};
 assert.ok(check().evaluationErrors>0);
});

test('exposure recording skips existing records and preserves the original audit row',async()=>{
 const store=Object.create(MysqlStore.prototype);const existing=new Map([['old',{id:'old',createdAt:'original'}]]);let inserted=0;
 store.pool={execute:async(sql,values)=>{
  if(sql.startsWith('SELECT id'))return[[...existing.keys()].filter(id=>values.includes(id)).map(id=>({id}))];
  for(let i=0;i<values.length;i+=2){if(!existing.has(values[i])){existing.set(values[i],JSON.parse(values[i+1]));inserted++;}}
  return[{}];
 }};
 await store.recordExposures([{id:'old',createdAt:'new'},{id:'new',createdAt:'now'}]);
 await store.recordExposures([{id:'old',createdAt:'later'},{id:'new',createdAt:'later'}]);
 assert.equal(inserted,1);assert.equal(existing.get('old').createdAt,'original');assert.equal(existing.get('new').createdAt,'now');
});

test('large navigation responses use negotiated gzip without changing JSON; other clients receive JSON',async()=>{
 const {sendNavigationJson}=await import('../src/navigation-response.js');const {gunzipSync}=await import('node:zlib');
 const value={items:Array.from({length:50},(_,i)=>({id:String(i),label:'Conversación con revisión humana'}))};
 for(const accepted of ['gzip','identity',null]){
  const headers={};let body;
  const req={get:()=>accepted,acceptsEncodings:()=>accepted};
  const res={vary:()=>res,set:(k,v)=>{headers[k]=v;return res;},type:()=>res,send:v=>{body=v;},json:v=>{body=v;}};
  await sendNavigationJson(req,res,value);
  assert.equal(headers['Cache-Control'],'private, no-store');
  if(accepted==='gzip'){assert.equal(headers['Content-Encoding'],'gzip');assert.deepEqual(JSON.parse(gunzipSync(body).toString()),value);assert.ok(body.length<JSON.stringify(value).length/2);}
  else{assert.equal(headers['Content-Encoding'],undefined);assert.deepEqual(body,value);}
 }
});

test('login session updates keep the shared write lock but never load evaluator tables',async()=>{
 const calls=[];const connection={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{},
  query:async(sql)=>{calls.push(sql);if(sql.includes('FROM sessions'))return[[{payload:{id:'old',userId:'u'}}]];return[[]];},
  execute:async(sql)=>{calls.push(sql);return[{}];}};
 const store=Object.create(MysqlStore.prototype);store.pool={getConnection:async()=>connection};
 await store.authenticationTransaction(state=>{state.sessions=[{id:'new',userId:'u'}];return true;});
 assert.ok(calls.some(sql=>sql.includes('app_lock')&&sql.includes('FOR UPDATE')));
 assert.ok(calls.some(sql=>sql.startsWith('INSERT INTO sessions')));assert.ok(calls.some(sql=>sql.startsWith('DELETE FROM sessions')));
 assert.ok(calls.every(sql=>!sql.includes('evaluations')&&!sql.includes('evaluation_tasks')&&!sql.includes('evaluation_attempts')));
});
