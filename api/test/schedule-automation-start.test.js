import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { automationConfiguration } from '../src/automation-configuration.js';
import { parseScheduleArguments, scheduleAutomationStart } from '../scripts/schedule-automation-start.js';

function fixture() {
  let state=createState(false);
  state.settings.version=28;
  state.settings.automation={...automationConfiguration(state.settings,[{code:'HN',name:'Honduras'}]),enabled:true,paused:true,
    countries:[{code:'HN',name:'Honduras',enabled:true,paused:false,dailyLimit:50}]};
  state.jobs=[{id:'old',status:'paused',total:2,completed:1,automation:{activityDate:'2026-11-17'},conversationCountries:{c:'HN'}}];
  state.tasks=[{id:'done',jobId:'old',conversationId:'c',status:'completed',profile:{id:'clef-local'},evidence:'keep'},
    {id:'pending',jobId:'old',conversationId:'c',status:'pending',profile:{id:'gemma-local'}}];
  state.evaluations=[{id:'saved',jobId:'old',results:[{value:1}]}];
  const store={async readAutomationState(){return structuredClone(state)},async transaction(fn){const draft=structuredClone(state);const result=await fn(draft);state=draft;return result}};
  const options={startsAt:new Date(Date.now()+86400000).toISOString(),cancelBefore:'2026-11-18',expectedVersion:28};
  return {store,options,get:()=>structuredClone(state)};
}
test('schedule arguments reject unknown, duplicate, missing or shell-like values before accessing configuration',()=>{
  const valid=['--starts-at=2026-11-19T06:01:00.000Z','--cancel-before=2026-11-18','--expected-version=28'];
  assert.deepEqual(parseScheduleArguments(valid),{startsAt:'2026-11-19T06:01:00.000Z',cancelBefore:'2026-11-18',expectedVersion:28});
  for(const args of [[],valid.slice(1),[...valid,'--apply=true'],[...valid,valid[0]],[valid[0],valid[1],'--expected-version=28;echo test']]) assert.throws(()=>parseScheduleArguments(args));
});
test('cancels only old unfinished work, preserves results and quotas, then schedules once',async()=>{
  const f=fixture();
  await f.store.transaction(s=>{s.jobs.push({id:'new',status:'paused',automation:{activityDate:'2026-11-18'}});s.tasks.push({id:'new-task',jobId:'new',status:'pending'})});
  const before=f.get();
  const result=await scheduleAutomationStart(f.store,f.options);
  assert.equal(result.version,29);assert.equal(result.paused,false);assert.equal(result.oldPendingReviews,0);
  assert.deepEqual(f.get().evaluations,before.evaluations);
  assert.deepEqual(f.get().tasks[0],before.tasks[0]);
  assert.equal(f.get().tasks[1].status,'deferred');assert.equal(f.get().tasks[2].status,'pending');
  assert.deepEqual(f.get().settings.automation.countries,before.settings.automation.countries);
  assert.equal(f.get().jobs[0].status,'cancelled');
  assert.deepEqual(await scheduleAutomationStart(f.store,f.options),result);
});
test('version mismatch, unpaused queue, past date or active worker prevent all mutations',async()=>{
  for(const change of [s=>{s.settings.version++},s=>{s.settings.automation.paused=false},s=>{s.jobs[0].status='running'}]){
    const f=fixture();await f.store.transaction(change);const before=f.get();
    await assert.rejects(scheduleAutomationStart(f.store,f.options));assert.deepEqual(f.get(),before);
  }
  const f=fixture();const before=f.get();await assert.rejects(scheduleAutomationStart(f.store,{...f.options,startsAt:'2000-01-01T00:00:00.000Z'}));assert.deepEqual(f.get(),before);
});
test('an interrupted cancellation cannot enable the queue and is safe to retry',async()=>{
  const f=fixture();
  f.store.evaluationWorker=()=>({transaction:async()=>{throw new Error('Lost connection')}});
  await assert.rejects(scheduleAutomationStart(f.store,f.options));assert.equal(f.get().settings.automation.paused,true);assert.equal(f.get().settings.version,28);
  delete f.store.evaluationWorker;
  assert.equal((await scheduleAutomationStart(f.store,f.options)).version,29);
});
