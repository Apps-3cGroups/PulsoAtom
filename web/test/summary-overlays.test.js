import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { StyleProvider, createCache, extractStyle } from '@ant-design/cssinjs';
import { createServer } from 'vite';

let vite, cacheDir, Summary, Active, ConversationEntry, PortalContext;
before(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'pulso-summary-overlays-'));
  vite = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
    cacheDir, logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ default: Summary } = await vite.ssrLoadModule('/src/pages/Summary.jsx'));
  ({ default: Active, ConversationEntry } = await vite.ssrLoadModule('/src/pages/Active.jsx'));
  ({ PortalContext } = await vite.ssrLoadModule('/src/hooks.js'));
});
after(async () => {
  await vite?.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

// Inspect the CSS emitted by the real page and installed Ant Design version,
// rather than duplicating a theme constant. No API requests or evaluation jobs run.
function popupLayers(css, className) {
  const rules = [...css.matchAll(new RegExp(`[^{}]*\\.${className}\\{([^{}]*)\\}`, 'g'))];
  const layers = rules.flatMap(([, body]) => {
    const match = body.match(/(?:^|;)z-index:\s*(\d+)(?:;|$)/);
    return match ? [Number(match[1])] : [];
  });
  assert.ok(layers.length, `Missing generated styles for ${className}`);
  return layers;
}

for (const days of [1, 3, 30]) {
  test(`Resumen ${days} días: los menús quedan por encima de los tooltips`, () => {
    const cache = createCache();
    const bootstrap = {
      mode: 'demo', timezone: 'America/Tegucigalpa',
      dateRange: { min: '2026-10-13', max: '2026-11-11' },
      countries: [{ code: 'HN', name: 'Honduras' }, { code: 'PA', name: 'Panamá' }],
      catalog: [],
    };
    const html = renderToString(h(StyleProvider, { cache },
      h(MemoryRouter, { initialEntries: [`/?days=${days}&countries=HN,PA`] },
        h(PortalContext.Provider, { value: { bootstrap } }, h(Summary)))));
    assert.match(html, /aria-label="Países del resumen"/);
    assert.match(html, />Excepciones<\/span>/);
    assert.equal((html.match(/aria-pressed="true"/g) || []).length, 6); // five exceptions and selected period
    assert.match(html, /data-icon="down"/);
    assert.doesNotMatch(html, /data-icon="search"/);
    assert.doesNotMatch(html, /Variable visible en el mapa|Mostrar pendientes|Todas las variables|map-footer|FIGURAS VISIBLES/);
    const css = extractStyle(cache, { plain: true });
    const menu = Math.min(...popupLayers(css, 'ant-select-dropdown'));
    const tooltip = Math.max(...popupLayers(css, 'ant-tooltip'));
    assert.ok(menu > tooltip,
      `Un tooltip (${tooltip}) puede bloquear las opciones del filtro (${menu})`);
  });
}

test('Activas renders only three selectable exceptions and a country arrow, including explicit empty selection', () => {
  const bootstrap = { countries: [{ code: 'PA', name: 'Panamá' }] };
  for (const [query, selected] of [['', 3], ['?figures=', 0]]) {
    const html = renderToString(h(MemoryRouter, { initialEntries: [`/activas${query}`] },
      h(PortalContext.Provider, { value: { bootstrap } }, h(Active))));
    assert.match(html, />Excepciones<\/span>/);
    assert.equal((html.match(/aria-pressed="true"/g) || []).length, selected);
    assert.equal((html.match(/class="legend-toggle exception-toggle/g) || []).length, 3);
    assert.match(html, /data-icon="down"/);
    assert.match(html, />Países<\/span>/);
    assert.doesNotMatch(html, /data-icon="search"|>Humano<|>Refutado<|Mostrar pendientes|Todas las variables/);
  }
});

test('Activas card renders a human critical flag only with its critical symbol and preserves return filters', () => {
  const conversation = { id: 'test', client: { name: 'Cliente' }, agent: { name: 'Asesor' }, country: 'PA',
    evaluated: true, evaluationStatus: 'evaluated', startedAt: '2026-11-10T12:00:00Z',
    marks: [{ id: 'human', name: 'Crítico vigente', kind: 'human', classification: 'critical', effective: true, origin: 'human' },
      { id: 'positive', name: 'Positivo oculto', kind: 'positive', classification: 'positive', effective: true },
      { id: 'refuted', name: 'Refutado oculto', kind: 'refuted', classification: 'critical', effective: false }] };
  const html = renderToString(h(MemoryRouter, null, h(ConversationEntry, { conversation, visible: ['critical'], returnTo: '/activas?countries=PA&figures=critical&page=2' })));
  assert.match(html, /Crítico vigente/);
  assert.match(html, /mark-critical/);
  assert.doesNotMatch(html, /mark-human|mark-refuted|mark-positive|Positivo oculto|Refutado oculto/);
  assert.match(html, /returnTo=%2Factivas%3Fcountries%3DPA%26figures%3Dcritical%26page%3D2/);
});
