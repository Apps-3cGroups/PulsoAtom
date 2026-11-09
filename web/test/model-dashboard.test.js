import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparisonScale, duration, metricLeader, modelDashboardDefaultFilters, modelDashboardPeriodLabel, percentage, resetModelDashboardFilters } from '../src/services/modelDashboard.js';

test('las barras comparten escala; cero, datos ausentes y porcentajes conservan significado', () => {
  assert.deepEqual(comparisonScale([1000, 2000]), [50, 100]);
  assert.deepEqual(comparisonScale([.2, .6], 1), [20, 60]);
  assert.deepEqual(comparisonScale([0, null]), [0, null]);
  assert.equal(duration(null), 'Sin datos'); assert.equal(duration(0), '0 ms');
  assert.equal(percentage(null), 'Sin datos'); assert.equal(percentage(0), '0 %');
});
test('ganador respeta la dirección del KPI y no declara victoria con datos incompletos', () => {
  const models = [{ label: 'GPT', value: 10 }, { label: 'Gemini', value: 20 }];
  assert.equal(metricLeader(models, 'value', true).label, 'GPT');
  assert.equal(metricLeader(models, 'value').label, 'Gemini');
  assert.equal(metricLeader([{ value: null }, { value: 1 }], 'value'), null);
  assert.equal(metricLeader([{ value: 1 }, { value: 1 }], 'value').tie, true);
});

test('la primera consulta real abarca siete días locales e ignora fechas históricas de carga', () => {
  const now = new Date('2027-01-01T05:30:00Z');
  const filters = modelDashboardDefaultFilters({ mode: 'real', timezone: 'America/Tegucigalpa',
    metadata: { lastLoadedAt: '2026-10-26T14:00:00Z' }, dateRange: { max: '2026-10-25' } }, now);
  assert.deepEqual(filters, { from: '2026-12-25', to: '2026-12-31', country: '', left: '', right: '' });
  assert.equal(modelDashboardDefaultFilters({ mode: 'real', timezone: 'Asia/Tokyo' }, now).to, '2027-01-01');
});

test('demo mantiene la semana sintética y convierte su carga a la zona del portal', () => {
  const now = new Date('2027-01-01T12:00:00Z');
  const bootstrap = { mode: 'demo', timezone: 'America/Tegucigalpa', metadata: { lastLoadedAt: '2026-10-26T03:00:00Z' } };
  assert.deepEqual(modelDashboardDefaultFilters(bootstrap, now), { from: '2026-10-19', to: '2026-10-25', country: '', left: '', right: '' });
  bootstrap.metadata.lastLoadedAt = 'invalid';
  bootstrap.dateRange = { max: '2026-10-25' };
  assert.equal(modelDashboardDefaultFilters(bootstrap, now).to, '2026-10-25');
  bootstrap.dateRange.max = '2026-02-30';
  assert.equal(modelDashboardDefaultFilters(bootstrap, now).to, '2027-01-01');
});

test('restablecer vuelve a siete días y todos los países sin cambiar la pareja de modelos', () => {
  const filters = { from: '', to: '', country: 'HN', left: 'clef@version', right: 'gemma@version' };
  const original = structuredClone(filters), now = new Date('2026-11-09T18:00:00Z');
  const reset = resetModelDashboardFilters(filters, { mode: 'real', timezone: 'America/Tegucigalpa' }, now);
  assert.deepEqual(reset, { from: '2026-11-03', to: '2026-11-09', country: '', left: 'clef@version', right: 'gemma@version' });
  assert.deepEqual(filters, original);
  assert.equal(modelDashboardPeriodLabel(reset, reset), 'Últimos 7 días · 2026-11-03 — 2026-11-09');
  assert.equal(modelDashboardPeriodLabel({ from: '2026-10-01', to: '' }, reset), '2026-10-01 — Sin límite');
  assert.equal(modelDashboardPeriodLabel({ from: '', to: '' }, reset), 'Todo el histórico');
});
