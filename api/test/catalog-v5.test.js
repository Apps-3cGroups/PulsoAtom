import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { catalogV5, CATALOG_REVISION, CATALOG_RULES_INSTRUCTIONS, migrateCatalogV5 } from '../src/catalog-v5.js';
import { createState } from '../src/data/seed.js';
import { addV5Demo } from '../src/data/v5-demo.js';

test('catalog v5 matches workbook classifications and phase counts', () => {
  assert.equal(catalogV5.length, 93);
  assert.equal(new Set(catalogV5.map(v => v.id)).size, 93);
  assert.equal(catalogV5.filter(v => v.mark === 'Crítico').length, 30);
  assert.equal(catalogV5.filter(v => v.type === 'Flag' && !v.mark).length, 43);
  assert.equal(catalogV5.filter(v => v.mark === '+').length, 6);
  assert.equal(catalogV5.filter(v => v.type === 'Métrica').length, 7);
  assert.equal(catalogV5.filter(v => v.type === 'Descriptor').length, 4);
  assert.equal(catalogV5.filter(v => v.type === 'Calculado').length, 3);
  assert.deepEqual([1, 2, 3].map(phase => catalogV5.filter(v => v.phase === phase).length), [64, 28, 1]);
  assert.deepEqual(['IA', 'Código', 'Cálculo'].map(method => catalogV5.filter(v => v.active && v.method === method).length), [49, 10, 5]);
  assert.ok(catalogV5.every(v => v.active === (v.phase === 1)));
  assert.match(CATALOG_RULES_INSTRUCTIONS, /Máximo 1 emoji/);
});

test('migration preserves existing snapshots, evaluations and reviews and retires removed IDs', () => {
  const catalog = JSON.parse(readFileSync(new URL('../src/data/catalog-legacy.json', import.meta.url)));
  const item = catalog.find(v => v.id === 'cliente_molesto');
  item.version = 4; item.name = 'Etiqueta histórica editada';
  const state = { catalog, catalogVersions: [{ id: `${item.id}:4`, itemId: item.id, version: 4, snapshot: structuredClone(item) }],
    settings: { dailyEnabled: true, dailyTime: '07:00' }, catalogAudit: [], evaluations: [{ id: 'old', catalogVersions: [{ id: item.id, version: 4 }] }],
    reviews: [{ id: 'review', evaluationId: 'old', variableId: item.id }], jobs: [{ id: 'job', mode: 'dual' }] };
  const before = JSON.stringify({ snapshot: state.catalogVersions[0], evaluations: state.evaluations, reviews: state.reviews, jobs: state.jobs });
  assert.equal(migrateCatalogV5(state, { now: '2026-11-03T12:00:00Z' }), true);
  assert.equal(state.catalog.filter(v => !v.retired).length, 93);
  assert.equal(state.catalog.filter(v => v.retired).length, 76);
  assert.ok(state.catalog.filter(v => v.retired).every(v => !v.active));
  assert.equal(state.catalog.find(v => v.id === item.id).version, 5);
  assert.equal(state.metadata.catalogRevision, CATALOG_REVISION);
  assert.equal(state.settings.dailyEnabled, true);
  assert.equal(before, JSON.stringify({ snapshot: state.catalogVersions[0], evaluations: state.evaluations, reviews: state.reviews, jobs: state.jobs }));
  const migrated = JSON.stringify(state);
  assert.equal(migrateCatalogV5(state), false);
  assert.equal(JSON.stringify(state), migrated);
});

test('migration does not overwrite portal edits after installation', () => {
  const state = { catalog: [], settings: {} };
  migrateCatalogV5(state);
  state.catalog[0].active = false;
  state.catalog[0].definition = 'Cambio posterior del administrador';
  assert.equal(migrateCatalogV5(state), false);
  assert.equal(state.catalog[0].active, false);
  assert.equal(state.catalog[0].definition, 'Cambio posterior del administrador');
});

test('fresh real state has only v5; demo historical evaluations retain original references', () => {
  const fresh = createState(false);
  assert.equal(fresh.catalog.length, 93);
  assert.equal(fresh.catalogVersions.length, 93);
  assert.equal(fresh.metadata.catalogRevision, CATALOG_REVISION);
  const demo = createState(true);
  assert.equal(demo.catalog.filter(v => !v.retired).length, 93);
  for (const evaluation of demo.evaluations) {
    for (const ref of evaluation.catalogVersions) assert.ok(demo.catalogVersions.some(v => v.id === `${ref.id}:${ref.version}`));
    assert.equal(evaluation.catalogVersions.filter(v => v.active).length, 12);
  }
});

test('v5 UI examples are explicit, optional and idempotent synthetic data', () => {
  assert.throws(() => addV5Demo(createState(false)), /demostración/);
  const state = createState(true);
  const count = state.conversations.length;
  addV5Demo(state);
  assert.equal(state.conversations.length, count + 4);
  assert.equal(state.jobs.find(j => j.id === 'demo-v5-dual').failed, 1);
  assert.ok(state.evaluations.filter(e => e.jobId === 'demo-v5-dual').every(e => e.demo));
  addV5Demo(state);
  assert.equal(state.conversations.length, count + 4);
});
