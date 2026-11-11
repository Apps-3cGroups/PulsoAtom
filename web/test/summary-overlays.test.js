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

let vite, cacheDir, Summary, PortalContext;
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
    assert.match(html, /aria-label="Variable visible en el mapa"/);
    const css = extractStyle(cache, { plain: true });
    const menu = Math.min(...popupLayers(css, 'ant-select-dropdown'));
    const tooltip = Math.max(...popupLayers(css, 'ant-tooltip'));
    assert.ok(menu > tooltip,
      `Un tooltip (${tooltip}) puede bloquear las opciones del filtro (${menu})`);
  });
}
