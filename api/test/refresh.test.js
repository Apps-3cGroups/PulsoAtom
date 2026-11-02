import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, initialCatalog } from '../src/data/seed.js';
import { eligibleConversations, runEvaluationBatch } from '../src/evaluation-service.js';
import { sourceFingerprint } from '../src/source-state.js';
import { validateEvaluation } from '../src/evaluator.js';
import { runDailyTick } from '../src/daily-scheduler.js';

function fixture() {
  const state = createState(false);
  state.settings = { ...state.settings, includeOpenConversations: true, refreshChangedConversations: true };
  state.conversations = [{ id:'open', country:'HN', completed:false, date:'2026-11-02', sourceCreatedAt:'2026-11-02T10:00:00Z', sourceUpdatedAt:'2026-11-02T10:00:00Z', messages:[{id:'m',actor:'cliente',text:'Hola',timestamp:'2026-11-02T10:00:00Z'}] }];
  const store = { async read() {return structuredClone(state);}, async readWithConversations(){return structuredClone(state);}, async transaction(fn){return fn(state);} };
  const evaluator={configured:true,async evaluate(c,vs){return {model:'mock',results:vs.map(v=>({variableId:v.id,status:'evaluado',value:0,reason:'Prueba',evidence:[]}))};}};
  return {state,store,evaluator};
}
test('abiertas habilitadas se evalúan provisionalmente y repetir la misma importación no duplica resultados',async()=>{
  const {state,store,evaluator}=fixture();
  assert.equal(eligibleConversations(state).length,1);
  await runEvaluationBatch(store,evaluator,{max:20});
  assert.equal(state.evaluations[0].provisional,true);
  assert.equal(state.evaluations[0].sourceHash,sourceFingerprint(state.conversations[0]));
  state.conversations[0].sourceUpdatedAt='2026-11-03T00:00:00Z';
  assert.equal(eligibleConversations(state).length,0);
  await runEvaluationBatch(store,evaluator,{max:20});
  assert.equal(state.evaluations.length,1);
});
test('un nuevo mensaje y el cierre vuelven a seleccionar el caso conservando resultados anteriores',async()=>{
  const {state,store,evaluator}=fixture();
  await runEvaluationBatch(store,evaluator,{max:20});
  state.conversations[0].messages.push({id:'m2',actor:'humano',text:'Buenas tardes'});
  assert.equal(eligibleConversations(state).length,1);
  await runEvaluationBatch(store,evaluator,{max:20});
  state.conversations[0].completed=true;
  await runEvaluationBatch(store,evaluator,{max:20});
  assert.equal(state.evaluations.length,3);
  assert.equal(state.evaluations.at(-1).provisional,false);
  assert.equal(eligibleConversations(state).length,0);
});
test('no guarda como vigente un resultado si Atom cambia mientras responde la IA',async()=>{
  const {state,store,evaluator}=fixture();
  const original=evaluator.evaluate;
  evaluator.evaluate=async(c,vs)=>{const r=await original(c,vs);state.conversations[0].messages.push({id:'new',actor:'cliente',text:'Otro mensaje'});return r;};
  const job=await runEvaluationBatch(store,evaluator,{max:20});
  assert.equal(job.failed,1);assert.equal(job.errors[0].code,'SOURCE_CHANGED');assert.equal(state.evaluations.length,0);
});
test('el mantenimiento impide iniciar trabajos normales y bloquea la programación diaria',async()=>{
  const {state,store,evaluator}=fixture();
  state.settings={...state.settings,evaluationMaintenance:'reset-1',dailyEnabled:true,dailyStartedAt:'2026-11-01T00:00:00Z'};
  await assert.rejects(runEvaluationBatch(store,evaluator,{max:20}),{code:'EVALUATION_MAINTENANCE'});
  assert.equal(await runDailyTick(store,evaluator,new Date('2026-11-02T13:00:00Z')),null);
  await runEvaluationBatch(store,evaluator,{max:20,maintenanceId:'reset-1'});
  assert.equal(state.evaluations.length,1);
});
test('el horario diario actualiza contenido nuevo y omite una importación idéntica',async()=>{
  const {state,store,evaluator}=fixture();
  state.settings={...state.settings,dailyEnabled:true,dailyStartedAt:'2026-11-01T00:00:00Z'};
  await runEvaluationBatch(store,evaluator,{max:20});
  state.conversations[0].messages.push({id:'m2',actor:'humano',text:'Respuesta'});
  state.conversations[0].sourceCreatedAt='2026-10-01T00:00:00Z';
  state.conversations[0].sourceUpdatedAt='2026-10-01T00:00:00Z';
  const job=await runDailyTick(store,evaluator,new Date('2026-11-02T13:00:00Z'));
  assert.deepEqual(job.conversationIds,['open']);
  for(let i=0;i<100&&state.jobs.at(-1).status==='running';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(state.evaluations.length,2);
  assert.equal(await runDailyTick(store,evaluator,new Date('2026-11-02T14:00:00Z')),null);
  const next=await runDailyTick(store,evaluator,new Date('2026-11-03T13:00:00Z'));
  assert.equal(next.total,0);
});
test('una conversación abierta no se marca definitivamente como último mensaje sin respuesta',()=>{
  const variable=initialCatalog.find(v=>v.id==='asistente_no_respondio_ultimo_mensaje');
  const result=validateEvaluation({results:{[variable.id]:{status:'evaluado',value:1,reason:'Texto',evidence_message_ids:['m']}}},[variable],fixture().state.conversations[0])[0];
  assert.equal(result.status,'no_evaluado');assert.equal(result.value,null);assert.deepEqual(result.evidence,[]);
});
test('la carga completa limita a tres las llamadas concurrentes y guarda una vez cada caso',async()=>{
  const {state,store,evaluator}=fixture();let active=0,peak=0;
  state.conversations=Array.from({length:7},(_,i)=>({...state.conversations[0],id:`case-${i}`}));
  const original=evaluator.evaluate;
  evaluator.evaluate=async(c,vs)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,20));active--;return original(c,vs);};
  const job=await runEvaluationBatch(store,evaluator,{max:20,concurrency:3});
  assert.equal(peak,3);assert.equal(job.completed,7);assert.equal(job.failed,0);
  assert.equal(new Set(state.evaluations.map(e=>e.conversationId)).size,7);
});
