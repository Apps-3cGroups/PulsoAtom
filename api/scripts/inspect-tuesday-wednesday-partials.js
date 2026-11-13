// Diagnostic only. No writes to Pulso/Atom, no retries, no result persistence.
import mysql from 'mysql2/promise';
import {databaseConfig,atomDatabaseConfig,config} from '../src/config.js';
import {AtomReader} from '../src/atom.js';
import {registryFromEnv} from '../src/model-registry.js';
import {supportsAiVariable} from '../src/evaluator.js';
import {sourceFingerprint} from '../src/evaluation-context.js';
import {createHash} from 'node:crypto';
const jobId='ee30980f-df37-4592-bae9-3090f49f5e3e';
const decode=v=>typeof v==='string'?JSON.parse(v):v;
const allowed=new Set('the a an is are was were to of for with in on from and or than when but this that not does can cannot failed failure error invalid input output prompt context length window tokens token max_tokens n_keep n_ctx model schema json grammar format request response maximum minimum exceeded exceeds limit too large small long short load loaded loading memory available unavailable prediction predicting generate generation decoding keep truncation truncate overflow overflows trying first please reduce number exceeds exceed messages message system user assistant role roles content expected found required properties additionalproperties array object integer string boolean null oneof anyof allof type items enum const property must be has have got supported unsupported support schema json_schema response_format constraint constraints size total requested available remaining insufficient internal validation value values syntax identifier eos bos chat template mismatch only at least greater less than equal context_length_exceeded context_window_exceeded input_context_length_exceeded status invalid_request_error bad_request'.split(' '));
function classify(value,depth=0){
 if(depth>4)return null;
 if(typeof value==='string')return {bytes:Buffer.byteLength(value),sha256:createHash('sha256').update(value).digest('hex'),pattern:value.slice(0,3000).toLowerCase().split(/\s+/).map(w=>/^\d{1,7}$/.test(w)?w:allowed.has(w.replace(/[^a-z_]/g,''))?w.replace(/[^a-z_]/g,''):'[redacted]').join(' ')};
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 return Object.fromEntries(['message','error','detail','code','type','param'].filter(k=>Object.hasOwn(value,k)).map(k=>[k,classify(value[k],depth+1)]));
}
const safeCode=e=>/^[A-Z_]{3,80}$/.test(e?.code||'')?e.code:'DIAGNOSTIC_FAILED';
const modelId=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(x)&&!x.includes('://')?x:null;
let db,reader;
try{
 db=await mysql.createConnection(databaseConfig());await db.query('START TRANSACTION READ ONLY');
 const [tr]=await db.query("SELECT payload FROM evaluation_tasks WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.jobId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.status'))='partial' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.error.code'))='AI_CONFIGURATION' ORDER BY sequence_id",[jobId]);
 const tasks=tr.map(r=>decode(r.payload));
 if(tasks.length!==3||tasks.filter(t=>t.profile.id==='clef-local').length!==1||tasks.filter(t=>t.profile.id==='gemma-local').length!==2)throw Object.assign(new Error(),{code:'PARTIAL_SCOPE_CHANGED'});
 const [jr]=await db.query('SELECT payload FROM evaluation_jobs WHERE id=?',[jobId]);
 const [sr]=await db.query("SELECT payload FROM portal_settings WHERE id='settings'");
 const job=decode(jr[0]?.payload),settings=decode(sr[0]?.payload);
 if(!job||!settings||job.modelProfiles.length!==2)throw Object.assign(new Error(),{code:'CONFIGURATION_MISSING'});
 const ids=job.catalogVersions.map(r=>`${r.id}:${r.version}`);
 const [cr]=await db.query(`SELECT payload FROM catalog_versions WHERE id IN (${ids.map(()=>'?').join(',')})`,ids);
 const versions=cr.map(r=>decode(r.payload));
 const catalog=job.catalogVersions.map(ref=>{const v=versions.find(v=>v.itemId===ref.id&&v.version===ref.version)?.snapshot;if(!v)throw Object.assign(new Error(),{code:'MISSING_CATALOG_VERSION'});return {...v,active:ref.active};});
 await db.commit();await db.end();db=null;
 reader=new AtomReader(atomDatabaseConfig(),config.timezone);
 const {conversations}=await reader.read({fresh:true,conversationIds:[...new Set(tasks.map(t=>t.conversationId))]});
 const results=[];
 for(let i=0;i<tasks.length;i++){
  const task=tasks[i],conversation=conversations.find(c=>c.id===task.conversationId);
  if(!conversation||sourceFingerprint(conversation)!==task.context.sourceHash)throw Object.assign(new Error(),{code:'SOURCE_CHANGED'});
  const diagnostics=[];
  const fetchImpl=async(...args)=>{const started=Date.now();const response=await fetch(...args);let body;try{body=await response.clone().json()}catch{body=null}
   if(!response.ok||body?.upstream_status_code>=400)diagnostics.push({httpStatus:response.status,upstreamStatus:Number.isInteger(body?.upstream_status_code)?body.upstream_status_code:null,durationMs:Date.now()-started,outer:classify(body),upstream:classify(body?.response)});
   return response;};
  const profile=registryFromEnv({fetchImpl}).forState({settings}).resolve(task.profile.id,task.profile);
  const prior=task.profileStates?.[task.profile.id]||{},retained=new Set((prior.results||[]).map(r=>r.variableId));
  const variables=catalog.filter(v=>v.active&&supportsAiVariable(v)&&!retained.has(v.id));
  const start=Date.now();let result,failure;
  if(variables.length)try{result=await profile.evaluator.evaluate(conversation,variables,{validationErrors:prior.validationErrors||[]})}catch(e){failure=safeCode(e)}
  const out={caseNumber:i+1,profileId:profile.id,requestedModel:profile.model,retainedVariables:retained.size,requestedVariables:variables.length,validVariables:result?.results?.length||0,returnedModel:modelId(result?.model),failure:failure||result?.failure?.code||null,elapsedMs:Date.now()-start,diagnostics};
  results.push(out);console.log(JSON.stringify(out));
 }
 console.log(JSON.stringify({finishedAt:new Date().toISOString(),readOnly:true,resultsSaved:false,cases:results.length,successful:results.filter(r=>!r.failure&&r.validVariables===r.requestedVariables).length}));
}catch(e){console.error(JSON.stringify({readOnly:true,errorCode:safeCode(e)}));process.exitCode=1}finally{await db?.end();await reader?.close()}
