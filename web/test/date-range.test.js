import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDateRange } from '../src/services/dateRange.js';

test('la semana inclusiva cruza meses y años sin cargar el mes completo', () => {
  assert.deepEqual(defaultDateRange('2026-11-03'), { from: '2026-10-28', to: '2026-11-03' });
  assert.deepEqual(defaultDateRange('2026-01-03'), { from: '2025-12-28', to: '2026-01-03' });
});
test('sin carga usa la fecha local del portal, no el día UTC siguiente', () => {
  assert.deepEqual(defaultDateRange(null, 'America/Tegucigalpa', new Date('2026-11-04T01:00:00Z')), { from: '2026-10-28', to: '2026-11-03' });
});
