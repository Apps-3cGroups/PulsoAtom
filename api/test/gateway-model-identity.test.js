import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyNumberedModelInstance } from '../src/services/gatewayModelIdentity.js';

const requested='gemma-4-26b-a4b-it-mlx',returned=`${requested}:2`;
const entry=()=>({key:requested,type:'llm',loaded_instances:[{id:returned,config:{context_length:8192,privateField:'must-not-be-copied'}}]});
const check=models=>verifyNumberedModelInstance({client:{invoke:async()=>({response:{models},requestId:'inventory-1'})},toolKey:'gemma',requested,returned,responseRequestId:'response-1'});
test('verifies exact native artifact binding and returns only audit identifiers and numeric context',async()=>{
  assert.deepEqual(await check([entry()]),{modelKey:requested,instanceId:returned,inventoryRequestId:'inventory-1',responseRequestId:'response-1',contextLength:8192});
});
test('rejects a similar name backed by a different artifact, duplicate instances, wrong type or malformed inventory',async()=>{
  for(const models of [[],[{...entry(),key:'different-model'}],[entry(),entry()],[{...entry(),type:'decision'}],[{key:requested,loaded_instances:null}],null]){
    await assert.rejects(check(models),e=>e.code==='MODEL_CHANGED');
  }
});
test('rejects unrelated model identities before performing inventory calls',async()=>{
  let calls=0;
  for(const bad of ['clef-flash',`${requested}:evil`,`${requested}-2`])await assert.rejects(verifyNumberedModelInstance({client:{invoke:async()=>{calls++;}},toolKey:'gemma',requested,returned:bad}),e=>e.code==='MODEL_CHANGED');
  assert.equal(calls,0);
});
