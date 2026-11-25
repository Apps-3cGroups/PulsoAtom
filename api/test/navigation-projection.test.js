import test from 'node:test';
import assert from 'node:assert/strict';
import { MysqlStore, AtomHistoryStore } from '../src/store.js';
import { navigationSummaryProjection, decodeNavigationSummary } from '../src/navigation-projection.js';
import { jsonRemoveProjection } from './fixtures/navigation-projection.js';
import { createState } from '../src/data/seed.js';

test('summary payloads omit instructions, evidence and retry copies while preserving every result value and contract hash', () => {
  const original = { id: 'e', sourceHash: 'source', modelPromptHash: 'profile-hash', promptHash: 'job-hash',
    promptSnapshot: { hash: 'profile-hash', text: 'Frozen instructions' },
    profileStates: { 'clef-local': { results: [{ value: 1 }] } }, codeResults: [{ value: 2 }],
    results: [{ variableId: 'flag', value: 1, evidence: [{ messageId: 'm', quote: 'Saved evidence' }], reason: 'Saved reason' }] };
  const evaluation = decodeNavigationSummary('evaluations', jsonRemoveProjection(original, navigationSummaryProjection('evaluations')));
  assert.equal(evaluation.promptSnapshot, undefined);
  assert.equal(evaluation.sourceHash, original.sourceHash);
  assert.equal(evaluation.modelPromptHash, original.modelPromptHash);
  assert.deepEqual(evaluation.results, [{ variableId: 'flag', value: 1 }]);
  assert.equal(original.results[0].evidence[0].quote, 'Saved evidence');
  const task = jsonRemoveProjection(original, navigationSummaryProjection('tasks'));
  assert.equal(task.profileStates, undefined); assert.equal(task.codeResults, undefined);
  assert.equal(task.promptHash, original.promptHash);
  const job = { runtimeConfiguration: { privateInstructions: 'Frozen runtime instructions' },
    modelProfiles: [{ id: 'clef-local', configurationHash: 'configuration' }],
    promptSnapshot: { version: 4, hash: 'job-hash', profiles: { 'clef-local': { hash: 'clef-hash', text: 'Clef', itemPrompts: { flag: 'Prompt' }, promptText: 'Configured' },
      'gemma-local': { hash: 'gemma-hash', text: 'Gemma', itemPrompts: {}, promptText: 'Configured' },
      'unrelated-profile': { hash: 'other-hash', text: 'Other original instructions' } } } };
  const projected = jsonRemoveProjection(job, navigationSummaryProjection('jobs'));
  assert.equal(projected.runtimeConfiguration, undefined);
  assert.equal(projected.promptSnapshot.hash, job.promptSnapshot.hash);
  assert.equal(projected.promptSnapshot.version, job.promptSnapshot.version);
  assert.deepEqual(projected.promptSnapshot.profiles['clef-local'], { hash: 'clef-hash' });
  assert.deepEqual(projected.promptSnapshot.profiles['gemma-local'], { hash: 'gemma-hash' });
  assert.deepEqual(projected.modelProfiles, job.modelProfiles);
  assert.equal(job.promptSnapshot.profiles['clef-local'].text, 'Clef');
  assert.equal(navigationSummaryProjection('comparisons'), 'payload');
});

test('result ordinals preserve duplicates, negatives, abstentions, errors and malformed entries without trusting aggregation order', () => {
  const results = [
    { variableId: 'same', status: 'evaluado', value: 1, type: 'Flag', method: 'IA' },
    { variableId: 'same', status: 'evaluado', value: 0 },
    { variableId: 'abstained', status: 'no_evaluado', value: null },
    { variableId: 'failed', status: 'no_evaluado', value: null, error: { code: 'INVALID_AI_RESULT' } },
    { variableId: 'code', status: 'evaluado', value: 1, codeRule: 'imposed' }, null,
  ];
  const projected = decodeNavigationSummary('evaluations', jsonRemoveProjection({ results }, navigationSummaryProjection('evaluations')));
  assert.deepEqual(projected.results, results);
  assert.deepEqual(decodeNavigationSummary('evaluations', { results: [] }).results, []);
  assert.deepEqual(decodeNavigationSummary('evaluations', { results: null }), { results: null });
});

test('summary and full navigation caches never share truncated evaluation, task or job records', async () => {
  const records = {
    evaluations: { id: 'e', conversationId: 'c', jobId: 'j', promptSnapshot: { text: 'Original evaluation prompt' }, results: [] },
    evaluation_tasks: { id: 't', conversationId: 'c', jobId: 'j', profileStates: { retained: 'Original retry state' } },
    evaluation_jobs: { id: 'j', runtimeConfiguration: { frozen: 'Original runtime' },
      promptSnapshot: { hash: 'h', profiles: { 'clef-local': { hash: 'p', text: 'Original job prompt' } } } },
  };
  const queries = [];
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    async query(sql) {
      queries.push(sql);
      const table = sql.match(/FROM (evaluations|evaluation_tasks|evaluation_jobs)\b/)?.[1], value = records[table];
      if (!value) return [[]];
      if (sql.includes('SHA2')) return [[{ id: value.id, revision: 'unchanged', sequence_id: 1 }]];
      return [[{ id: value.id, payload: jsonRemoveProjection(value, sql) }]];
    } };
  const store = Object.create(MysqlStore.prototype);
  store.navigationColumns = new Set(['evaluations', 'evaluation_tasks']); store.navigationColumnsAt = Date.now();
  store.pool = { getConnection: async () => connection };
  const summary = await store.readNavigation(['c'], { summaryOnly: true });
  assert.equal(summary.evaluations[0].promptSnapshot, undefined);
  assert.equal(summary.tasks[0].profileStates, undefined);
  assert.equal(summary.jobs[0].runtimeConfiguration, undefined);
  const full = await store.readNavigation(['c']);
  assert.equal(full.evaluations[0].promptSnapshot.text, 'Original evaluation prompt');
  assert.equal(full.tasks[0].profileStates.retained, 'Original retry state');
  assert.equal(full.jobs[0].runtimeConfiguration.frozen, 'Original runtime');
  assert.equal(full.jobs[0].promptSnapshot.profiles['clef-local'].text, 'Original job prompt');
  const reads = queries.filter(sql => sql.startsWith('SELECT id,') && sql.includes(' AS payload ')).length;
  await store.readNavigation(['c'], { summaryOnly: true }); await store.readNavigation(['c']);
  assert.equal(queries.filter(sql => sql.startsWith('SELECT id,') && sql.includes(' AS payload ')).length, reads);
});

test('large summary misses fetch every payload in bounded batches within one snapshot and preserve sequence order', async () => {
  const records = Array.from({ length: 501 }, (_, index) => ({ id: `e-${index}`, conversationId: 'c', results: [], sequence_id: index + 1 }));
  const batches = []; let begins = 0, commits = 0;
  const connection = { beginTransaction: async () => { begins++; }, commit: async () => { commits++; }, rollback: async () => {}, release() {},
    async query(sql, values) {
      if (!sql.includes('FROM evaluations')) return [[]];
      if (sql.includes('SHA2')) return [records.map(({ id, sequence_id }) => ({ id, sequence_id, revision: 'same' }))];
      batches.push(values);
      return [records.filter(row => values.includes(row.id)).reverse().map(row => ({ id: row.id, payload: jsonRemoveProjection(row, sql) }))];
    } };
  const store = Object.create(MysqlStore.prototype);
  store.navigationColumns = new Set(['evaluations', 'evaluation_tasks']); store.navigationColumnsAt = Date.now();
  store.pool = { getConnection: async () => connection };
  const state = await store.readNavigation(['c'], { summaryOnly: true });
  assert.deepEqual(batches.map(batch => batch.length), [250, 250, 1]);
  assert.deepEqual(state.evaluations.map(row => row.id), records.map(row => row.id));
  assert.equal(new Set(batches.flat()).size, 501);
  assert.equal(begins, 1); assert.equal(commits, 1);
});

test('summary projection is explicit and raw model or ordinary navigation retains the full read path', async () => {
  const options = [];
  const base = { async readNavigation(ids, selected) { options.push(selected); return createState(false); } };
  const source = { conversations: [], countries: [], loadedAt: '2026-11-25T16:00:00Z' };
  const reader = { async readOverview() { return structuredClone(source); }, async hydrateOverview(conversations) { return conversations; } };
  const store = new AtomHistoryStore(base, reader);
  await store.readForNavigation({});
  await store.readForNavigation({}, { summaryOnly: true });
  await store.readForNavigation({ modelProfileId: 'clef-local' }, { summaryOnly: true });
  assert.deepEqual(options, [{ summaryOnly: false }, { summaryOnly: true }, { summaryOnly: false }]);
});
