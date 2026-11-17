import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryCapacity, recoveryBaseline, recoveryPilotResult } from '../src/gemma-recovery-throughput.js';
import { RECOVERY_JOBS } from '../src/gemma-incident-recovery.js';
const jobId = RECOVERY_JOBS[0], conversationIds = Array.from({length: 8}, (_, i) => String(i));
const startedAt = '2026-11-12T19:00:00Z', finishedAt = '2026-11-12T19:02:00Z';
function fixture() {
  return { tasks: conversationIds.flatMap(conversationId => ['clef-local', 'gemma-local'].map(id => ({
    id: `${conversationId}:${id}`, conversationId, jobId, profile: { id }, status: 'completed',
  }))), attempts: [] };
}
test('parallel capacity requires one loaded instance of the exact artifact and never exceeds four', () => {
 const model = 'gemma-test', entry = { key: model, type: 'llm', loaded_instances: [{ id: model, config: { parallel: 8 } }] };
 assert.equal(recoveryCapacity({models: [entry]}, model), 4);
 for (const inventory of [null, {models: {}}, {models: [null]}, {models: [entry, entry]},
  {models: [{...entry, key: 'other'}]}, {models: [{...entry, loaded_instances: []}]},
  {models: [{...entry, loaded_instances: [...entry.loaded_instances, ...entry.loaded_instances]}]},
  {models: [{...entry, loaded_instances: [{config: {parallel: -1}}]}]}]) assert.equal(recoveryCapacity(inventory, model), 1);
});
test('baseline counts newly completed dual conversations, not individual model evaluations', () => {
 const state = fixture(); state.tasks.find(t => t.id === '7:gemma-local').status = 'pending';
 state.tasks.find(t => t.id === '6:gemma-local').status = 'running';
 const completed = state.tasks.filter(t => t.profile.id === 'clef-local' || Number(t.conversationId) < 2).map(t => ({taskId: t.id}));
 const baseline = recoveryBaseline(state, {completed}, startedAt, finishedAt);
 assert.equal(baseline.completed, 4); assert.equal(baseline.perMinute, 2);
 assert.equal(recoveryBaseline(state, {completed}, finishedAt, startedAt), null);
});
test('four-way pilot must finish every conversation and improve actual throughput before retaining four', () => {
 const state = fixture(), before = structuredClone(state);
 const args = {jobId, conversationIds, startedAt, finishedAt, baselineRate: 1};
 assert.equal(recoveryPilotResult(state, args).concurrency, 4);
 assert.equal(recoveryPilotResult(state, {...args, baselineRate: 4}).concurrency, 2);
 assert.equal(recoveryPilotResult(state, {...args, baselineRate: 0}).concurrency, 2);
 assert.deepEqual(state, before);
 state.tasks[0].status = 'partial';
 assert.equal(recoveryPilotResult(state, args).concurrency, 2);
});
test('a technical failure during the pilot restores two even if a later retry completes', () => {
 const state = fixture(), args = {jobId, conversationIds, startedAt, finishedAt, baselineRate: 1};
 state.attempts.push({taskId: state.tasks[0].id, startedAt, error: {code: 'AI_TRANSIENT'}});
 assert.equal(recoveryPilotResult(state, args).runtimeErrors, 1);
 assert.equal(recoveryPilotResult(state, args).concurrency, 2);
 state.attempts[0].startedAt = '2026-11-12T18:59:00Z';
 assert.equal(recoveryPilotResult(state, args).concurrency, 4);
 state.attempts[0] = {taskId: state.tasks[0].id, startedAt, error: {code: 'INVALID_AI_RESULT'}};
 assert.equal(recoveryPilotResult(state, args).concurrency, 4);
});
