import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canActivateCatalogDraft, canActivateCatalogItem } from '../src/services/catalogAvailability.js';
import { flagCountLabel } from '../src/services/flags.js';

test('unavailable integrations stay disabled even when the catalog record can be edited', () => {
  const item = { phase: 2, type: 'Flag', method: 'IA + código', availability: { canActivate: false, status: 'pending', reason: 'Requiere inventario' } };
  assert.equal(canActivateCatalogItem(item), false);
  assert.equal(canActivateCatalogDraft(item, { ...item, phase: 1 }), false);
  assert.equal(canActivateCatalogDraft(item, { ...item, phase: 1, method: 'IA' }), true);
  assert.equal(canActivateCatalogDraft(item, { ...item, method: 'IA' }), false);
});

test('pending data does not disable an implemented phase-one rule; unsupported new computations cannot be enabled', () => {
  const implemented = { phase: 1, type: 'Flag', method: 'Código', availability: { canActivate: true, status: 'pending' } };
  assert.equal(canActivateCatalogItem(implemented), true);
  assert.equal(canActivateCatalogDraft(implemented, { ...implemented, type: 'Métrica' }), false);
  assert.equal(canActivateCatalogDraft(null, { phase: 1, type: 'Métrica', method: 'Código' }), false);
  assert.equal(canActivateCatalogDraft(null, { phase: 1, type: 'Flag', method: 'IA' }), true);
});

test('flag counters use the matching singular and plural Spanish labels', () => {
  assert.equal(flagCountLabel('critical', 1), '1 flag crítico');
  assert.equal(flagCountLabel('critical', 2), '2 flags críticos');
  assert.equal(flagCountLabel('normal', 2), '2 flags normales');
  assert.equal(flagCountLabel('positive', 2), '2 positivos');
});
