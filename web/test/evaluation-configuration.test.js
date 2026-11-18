import test from 'node:test';
import assert from 'node:assert/strict';
import { automationActivation, sameEvaluationConfiguration } from '../src/services/evaluationConfiguration.js';

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

test('the saved start displays in the configured timezone and switches to active at the boundary', () => {
  const configuration = { enabled: true, paused: false, startsAt: '2026-11-19T06:01:00.000Z', timezone: 'America/Tegucigalpa' };
  const before = new Date('2026-11-19T06:00:59.999Z');
  const scheduled = automationActivation(configuration, before);
  assert.equal(scheduled.label, 'Programada');
  assert.match(scheduled.startsAtText, /19 de noviembre de 2026/);
  assert.match(scheduled.startsAtText, /00:01/);
  assert.equal(automationActivation(configuration, new Date(configuration.startsAt)).label, 'Activada');
  assert.equal(automationActivation({ ...configuration, paused: true }, before).label, 'Pausada');
  assert.equal(automationActivation({ ...configuration, enabled: false }, before).label, 'Desactivada');
  assert.equal(sameEvaluationConfiguration(configuration, { ...configuration, startsAt: null }), false);
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
