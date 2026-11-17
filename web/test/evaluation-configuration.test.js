import test from 'node:test';
import assert from 'node:assert/strict';
import { sameEvaluationConfiguration } from '../src/services/evaluationConfiguration.js';

const draft = {
  enabled: false, modelOrder: ['clef-local', 'gemma-local'],
  countries: [{ code: 'HN', enabled: true, paused: false, dailyLimit: 200 }],
  prompts: { mode: 'per-model', byModel: { 'clef-local': 'Prompt Clef', 'gemma-local': 'Prompt Gemma' },
    byItem: { flag: { mode: 'shared', shared: 'Criterio' } } },
};

test('checking a successful save accepts JSON key reordering, including country and prompt objects', () => {
  const reorder = value => Array.isArray(value) ? value.map(reorder)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  const persisted = reorder(draft);
  assert.notEqual(JSON.stringify(draft), JSON.stringify(persisted));
  assert.equal(sameEvaluationConfiguration(draft, persisted), true);
});

test('verification rejects real differences in activation, quotas, prompts and execution order', () => {
  for (const change of [
    value => { value.enabled = true; },
    value => { value.countries[0].dailyLimit = 50; },
    value => { value.prompts.byItem.flag.shared = 'Otro criterio'; },
    value => { value.modelOrder.reverse(); },
  ]) {
    const persisted = structuredClone(draft); change(persisted);
    assert.equal(sameEvaluationConfiguration(draft, persisted), false);
  }
});
