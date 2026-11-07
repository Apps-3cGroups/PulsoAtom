import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { runEvaluationBatch } from '../src/evaluation-service.js';
import { evaluationContext } from '../src/evaluation-context.js';
import { comparisonRows } from '../src/comparisons.js';

function fixture(evaluate) {
  const state = createState(false);
  state.catalog = state.catalog.filter(v => v.active && v.type === 'Flag' && v.method === 'IA').slice(0, 2);
  assert.equal(state.catalog.length, 2);
  state.conversations = [{ id: 'synthetic-output-channel', country: 'HN', date: '2026-11-07', completed: true,
    client: { name: 'Cliente sintético' }, agent: { id: 'synthetic-agent', name: 'Asesor sintético' },
    messages: [{ id: 'm1', actor: 'cliente', text: 'Consulta sintética.', timestamp: '2026-11-07T15:00:00Z' }] }];
  state.settings.aiPolicy = { mode: 'single', primaryId: 'clef-local', fallbackId: null, version: 1 };
  const store = {
    async read() { return structuredClone(state); },
    async transaction(fn) {
      const draft = structuredClone(state), result = await fn(draft);
      Object.assign(state, draft);
      return structuredClone(result);
    },
  };
  const registry = new ModelRegistry(['clef-local', 'gemma-local'].map((id, index) => ({
    id, provider: 'gateway', model: index ? 'synthetic-gemma' : 'clef-flash', label: id, enabled: true,
    evaluator: { configured: true, toolKey: 'gemma', portalKey: 'portal-pulso', responseFormat: 'json_schema',
      ...(index === 0 ? { outputSchemaVersion: 'clef-flash-schema-1', decisionInstructionsVersion: 'clef-flash-decisions-1' } : {}),
      maxTokens: 16000, temperature: 0, baseUrl: 'http://gateway.synthetic', timeoutMs: 180000,
      async evaluate(conversation, variables) {
        return { ...(index === 0 ? { decisionInstructionsVersion: 'clef-flash-decisions-1' } : {}),
          ...await evaluate(index, conversation, variables), model: index ? 'synthetic-gemma' : 'clef-flash',
          ...(index === 0 ? { outputSchemaVersion: 'clef-flash-schema-1' } : {}) };
      } },
  })));
  return { state, store, registry };
}
const results = (conversation, variables) => variables.map(v => ({ variableId: v.id, type: v.type, method: v.method,
  status: 'evaluado', value: 1, reason: 'Evento sintético.', evidence: [{ messageId: 'm1', quote: conversation.messages[0].text }] }));

test('each retry records its own output field without duplicating results or changing model equivalence', async () => {
  const calls = [[], []];
  const { state, store, registry } = fixture((index, conversation, variables) => {
    calls[index].push(variables.map(v => v.id));
    const firstPartial = index === 0 && calls[index].length === 1;
    return { responseField: firstPartial ? 'reasoning_content' : 'content',
      results: results(conversation, firstPartial ? variables.slice(0, 1) : variables),
      reasoning_content: 'RAW_PRIVATE_REASONING_MUST_NOT_PERSIST',
      validationErrors: firstPartial ? [{ variableId: variables[1].id, rules: ['missing_item'], message: 'Falta resultado.' }] : [] };
  });
  const context = evaluationContext(state.conversations[0], state.catalog), profile = registry.snapshot(registry.resolve('clef-local'));
  const job = await runEvaluationBatch(store, registry, { purpose: 'comparison', modelIds: ['clef-local', 'gemma-local'], max: 1 });
  assert.equal(job.status, 'completed');
  const attempts = state.attempts.filter(a => a.profileId === 'clef-local');
  assert.deepEqual(attempts.map(a => [a.status, a.responseField]), [['partial', 'reasoning_content'], ['completed', 'content']]);
  assert.deepEqual(calls[0], [state.catalog.map(v => v.id), [state.catalog[1].id]]);
  assert.equal(calls[1].length, 1);
  assert.ok(attempts.every(a => a.actualModel === 'clef-flash'));
  assert.ok(attempts.every(a => a.outputSchemaVersion === 'clef-flash-schema-1'));
  assert.ok(attempts.every(a => a.decisionInstructionsVersion === 'clef-flash-decisions-1'));
  const evaluation = state.evaluations.find(e => e.profileId === 'clef-local');
  assert.equal(evaluation.model, 'clef-flash');
  assert.equal(evaluation.results.length, 2);
  assert.equal(new Set(evaluation.results.map(r => r.variableId)).size, 2);
  assert.equal(evaluation.modelConfiguration.configurationHash, profile.configurationHash);
  assert.equal(evaluation.modelConfiguration.outputSchemaVersion, 'clef-flash-schema-1');
  assert.equal(evaluation.modelConfiguration.decisionInstructionsVersion, 'clef-flash-decisions-1');
  assert.equal(evaluation.decisionInstructionsVersion, 'clef-flash-decisions-1');
  assert.equal(state.tasks.find(t => t.profile.id === 'clef-local').profileStates['clef-local'].decisionInstructionsVersion, 'clef-flash-decisions-1');
  assert.ok(state.attempts.filter(a => a.profileId === 'gemma-local').every(a => !Object.hasOwn(a, 'decisionInstructionsVersion')));
  assert.ok(!Object.hasOwn(state.evaluations.find(e => e.profileId === 'gemma-local'), 'decisionInstructionsVersion'));
  for (const [key, value] of Object.entries(context)) assert.equal(evaluation[key], value);
  assert.ok(!Object.hasOwn(evaluation, 'responseField'));
  assert.ok(!Object.hasOwn(state.tasks.find(t => t.profile.id === 'clef-local').profileStates['clef-local'], 'responseField'));
  assert.ok(!Object.hasOwn(evaluation, 'protocol'));
  assert.ok(comparisonRows(state, state.comparisons[0]).every(row => row.votes === 2 && row.detections === 2));
  assert.ok(!JSON.stringify(state).includes('RAW_PRIVATE_REASONING_MUST_NOT_PERSIST'));
});

test('missing or unrecognized output fields never become persisted metadata', async () => {
  for (const responseField of [undefined, null, 'PRIVATE_RAW_OUTPUT', { content: 'PRIVATE_RAW_OUTPUT' }]) {
    const { state, store, registry } = fixture((_index, conversation, variables) => ({ responseField, results: results(conversation, variables) }));
    const job = await runEvaluationBatch(store, registry, { max: 1 });
    assert.equal(job.status, 'completed');
    assert.equal(state.attempts.length, 1);
    assert.ok(!Object.hasOwn(state.attempts[0], 'responseField'));
    assert.ok(!JSON.stringify(state).includes('PRIVATE_RAW_OUTPUT'));
  }
});

test('only the recognized decision instructions version from the configured Clef evaluator is retained', async () => {
  for (const decisionInstructionsVersion of [undefined, null, 'PRIVATE_INSTRUCTIONS', { text: 'PRIVATE_INSTRUCTIONS' }, 'clef-flash-decisions-2']) {
    const { state, store, registry } = fixture((_index, conversation, variables) => ({ decisionInstructionsVersion, results: results(conversation, variables) }));
    assert.equal((await runEvaluationBatch(store, registry, { max: 1 })).status, 'completed');
    assert.ok(!Object.hasOwn(state.attempts[0], 'decisionInstructionsVersion'));
    assert.ok(!Object.hasOwn(state.evaluations[0], 'decisionInstructionsVersion'));
    assert.ok(!Object.hasOwn(state.tasks[0].profileStates['clef-local'], 'decisionInstructionsVersion'));
    assert.ok(!JSON.stringify(state).includes('PRIVATE_INSTRUCTIONS'));
  }
});
