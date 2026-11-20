import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseGateway, summarizeResponse } from '../scripts/diagnose-local-gateway.mjs';

test('diagnostic summary never emits arbitrary upstream bodies, headers or generated text',()=>{
  const secret='credential-that-must-stay-private';
  const result=summarizeResponse(502,new Headers({'server':'nginx','set-cookie':secret}),JSON.stringify({detail:secret,choices:[{message:{content:secret}}]}),20);
  assert.equal(result.status,502);assert.equal(result.server,'nginx');assert.equal(JSON.stringify(result).includes(secret),false);
  assert.equal(summarizeResponse(502,new Headers(),'{"detail":"Tool connection error"}',1).detail,'Tool connection error');
});
test('failed model inventory skips generation and does not leak transport errors or tokens',async()=>{
  const token='private-token';const calls=[];
  const result=await diagnoseGateway({baseUrl:'http://gateway.test',token,portalKey:'portal-pulso',profiles:[{id:'gemma-local',toolKey:'gemma',model:'gemma-test'}],fetchImpl:async(url,options)=>{
    calls.push({url,options});return new Response('{"detail":"Tool connection error"}',{status:502});
  }});
  assert.equal(calls.length,2);assert.equal(result.results[1].status,502);assert.ok(calls.every(c=>c.options.redirect==='error'));
  assert.equal(JSON.stringify(result).includes(token),false);
});
test('healthy inventory probes each selected model once using a fixed harmless prompt',async()=>{
  const bodies=[];
  const result=await diagnoseGateway({baseUrl:'http://gateway.test',token:'secret',portalKey:'portal-pulso',profiles:[{id:'clef-local',toolKey:'gemma',model:'clef-flash'},{id:'gemma-local',toolKey:'gemma',model:'gemma-test'}],fetchImpl:async(url,options)=>{
    const body=options.body?JSON.parse(options.body):null;if(body)bodies.push(body);
    return new Response(JSON.stringify(body?.path==='/v1/models'?{upstream_status_code:200,response:{data:[{id:'clef-flash'},{id:'gemma-test'}]}}:body?{upstream_status_code:200,response:{choices:[{message:{content:'OK'}}]}}:{}));
  }});
  assert.equal(result.results.filter(r=>r.completionPresent).length,2);
  assert.deepEqual(bodies.filter(b=>b.body).map(b=>b.body.model),['clef-flash','gemma-test']);
  assert.ok(bodies.filter(b=>b.body).every(b=>b.body.max_tokens===16));
});
