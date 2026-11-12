import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryPlan, prepareRecovery, verifyPreservedResults, RECOVERY_ID, RECOVERY_JOBS } from '../src/gemma-incident-recovery.js';

function fixture() {
  return { settings: { dailyEnabled: true }, jobs: RECOVERY_JOBS.map((id,i) => ({ id, purpose:'operational',mode:'dual',status:i?'running':'partial',dailyActivity:{date:'2026-11-10',timezone:'America/Tegucigalpa'},conversationIds:[String(i)],modelProfiles:[{id:'clef-local'},{id:'gemma-local'}] })),
    tasks: RECOVERY_JOBS.flatMap((jobId,i)=>[{id:`c${i}`,jobId,conversationId:String(i),profile:{id:'clef-local'},status:'completed',evaluationId:`e${i}`,round:1},{id:`g${i}`,jobId,conversationId:String(i),profile:{id:'gemma-local'},status:i?'running':'partial',round:1,profileStates:{'gemma-local':{results:[{variableId:'preserved',value:1}]}}}]),
    evaluations:[{id:'e0',results:[{variableId:'a',value:1}]},{id:'e1',results:[{variableId:'b',value:0}]}],
    attempts:[{id:'a',jobId:RECOVERY_JOBS[1],status:'running'},{id:'historical',jobId:RECOVERY_JOBS[0],status:'failed'}] };
}
test('recovery interrupts unfinished work and preserves all completed results, retries and daily settings',()=>{
  const s=fixture(), before=structuredClone(s), plan=recoveryPlan(s);
  prepareRecovery(s,plan,'2026-11-12T16:00:00Z');
  assert.equal(s.settings.evaluationMaintenance,RECOVERY_ID);
  assert.equal(s.settings.dailyEnabled,true);
  assert.deepEqual(s.evaluations,before.evaluations);
  assert.deepEqual(s.tasks.filter(t=>t.status==='completed'),before.tasks.filter(t=>t.status==='completed'));
  assert.deepEqual(s.tasks.map(t=>t.profileStates),before.tasks.map(t=>t.profileStates));
  assert.equal(s.tasks.find(t=>t.id==='g1').status,'interrupted');
  assert.equal(s.attempts[0].interruptionReason,'authorized-gemma-identity-recovery');
  assert.deepEqual(s.attempts[1],before.attempts[1]);
  assert.equal(verifyPreservedResults(s,plan),2);
});
test('rejects another running job, maintenance or a different activity date',()=>{
  for(const change of [s=>s.jobs.push({id:'other',status:'running'}),s=>s.settings.evaluationMaintenance='other',s=>s.jobs[0].dailyActivity.date='2026-11-09']){
    const s=fixture();change(s);assert.throws(()=>recoveryPlan(s));
  }
});
test('rejects a stale recovery plan and detects changes to completed evaluations',()=>{
  const s=fixture(),plan=recoveryPlan(s);s.tasks[1].status='failed';assert.throws(()=>prepareRecovery(s,plan,'now'),/RECOVERY_STATE_CHANGED/);
  s.evaluations[0].results[0].value=0;assert.throws(()=>verifyPreservedResults(s,plan),/COMPLETED_RESULT_CHANGED/);
});
