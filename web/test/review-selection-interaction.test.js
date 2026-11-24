import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dom, h, act, createRoot, createMemoryRouter, RouterProvider, ConfigProvider, Summary, Conversations, Conversation, PortalContext, root, router;
const originalFetch = globalThis.fetch;
const requests = [];
const reviewSelection = { id: 'review94', title: 'Selección para revisión', from: '2026-11-17', to: '2026-11-19', count: 94, sourceChangedCount: 68, timeCorrectionCount: 68,
  countries: [{ code: 'HN', count: 47 }, { code: 'PA', count: 47 }], reviewAt: '2026-11-25T01:00:00Z' };
const bootstrap = { reviewSelection, mode: 'demo', timezone: 'America/Tegucigalpa',
  dateRange: { min: '2026-11-01', max: '2026-11-24' }, activityDateRange: { min: '2026-11-01', max: '2026-11-24' },
  countries: [{ code: 'HN', name: 'Honduras' }, { code: 'PA', name: 'Panamá' }], agents: [], catalog: [] };
const rows = Array.from({ length: 94 }, (_, index) => ({
  id: String(index), country: index % 2 ? 'PA' : 'HN', countryName: index % 2 ? 'Panamá' : 'Honduras',
  agent: { id: `agent-${index % 2}`, name: 'Asistente' }, client: { name: `Cliente ${index}` },
  displayDate: `2026-11-${17 + index % 3}`, displayAt: `2026-11-${17 + index % 3}T12:00:00Z`,
  startedAt: '2026-11-17T12:00:00Z', activityAt: '2026-11-24T12:00:00Z', displayTimezone: 'America/Tegucigalpa',
  evaluated: true, evaluationStatus: index === 0 ? 'review_pending' : index === 1 ? 'partial' : 'evaluated',
  sourceChanged: index < 68, evaluationErrors: index === 1 ? 1 : 0, marks: [], p1: 0, p2: 0, positive: 0,
  topics: [], media: [], channel: 'WhatsApp', variables: [], messages: [], reviews: [],
}));

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><main id="test"></main></body></html>', { url: 'http://localhost/pulsoAtom/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLBodyElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'SVGElement', 'ShadowRoot', 'Node', 'MutationObserver']) globalThis[key] = dom.window[key];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.getComputedStyle = element => dom.window.getComputedStyle(element);
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.MessageChannel = dom.window.MessageChannel;
  dom.window.matchMedia = query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  ({ createElement: h, act } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  ({ createMemoryRouter, RouterProvider } = await import('react-router-dom'));
  ({ ConfigProvider } = await import('antd'));
  const require = createRequire(import.meta.url);
  const folder = await mkdtemp(join(tmpdir(), 'pulso-review-selection-'));
  try {
    const result = await build({ stdin: {
      contents: "export {default as Summary} from './pages/Summary.jsx'; export {default as Conversations} from './pages/Conversations.jsx'; export {default as Conversation} from './pages/Conversation.jsx'; export {PortalContext} from './hooks.js';",
      resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
    }, bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' },
    plugins: [{ name: 'packages', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }] });
    const file = join(folder, 'review-selection.mjs');
    await writeFile(file, result.outputFiles[0].text);
    ({ Summary, Conversations, Conversation, PortalContext } = await import(pathToFileURL(file).href));
  } finally { await rm(folder, { recursive: true, force: true }); }
  globalThis.fetch = async input => {
    const url = new URL(input, 'http://localhost');
    requests.push(url);
    const country = url.searchParams.get('country') || url.searchParams.get('countries');
    const selected = rows.filter(row => !country || country.split(',').includes(row.country));
    let body;
    if (url.pathname.endsWith('/summary')) body = { conversations: url.searchParams.has('reviewSelection') ? selected : [], metadata: {} };
    else if (url.pathname.endsWith('/conversations')) {
      const page = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('pageSize') || 15);
      body = { items: selected.slice((page - 1) * size, page * size), total: selected.length, page, pageSize: size };
    } else {
      const conversation = rows.find(row => row.id === url.pathname.split('/').at(-1));
      assert.ok(conversation, `Unexpected API request: ${url.pathname}`);
      body = { conversation: { ...conversation, evaluation: { sourceChanged: conversation.sourceChanged, evaluatedCount: 0, modelReviews: [] } } };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  router?.dispose(); root = null; router = null; requests.length = 0;
});
after(() => { globalThis.fetch = originalFetch; dom?.window.close(); });

async function render(url = '/') {
  router = createMemoryRouter([{ path: '/', element: h(Summary) }, { path: '/historico', element: h(Conversations) }, { path: '/conversacion/:id', element: h(Conversation) }], { initialEntries: [url] });
  root = createRoot(document.querySelector('#test'));
  await act(async () => root.render(h(ConfigProvider, { theme: { token: { motion: false } } },
    h(PortalContext.Provider, { value: { bootstrap, user: { role: 'supervisor' } } }, h(RouterProvider, { router })))));
}
const button = text => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text);
async function click(element) {
  assert.ok(element, 'Expected actionable element');
  await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
}
const latestRequest = () => requests.at(-1);

test('default entry renders all 94; each preset opts out and the selection can be restored', async () => {
  await render();
  assert.equal(new URLSearchParams(router.state.location.search).get('reviewSelection'), reviewSelection.id);
  assert.equal(latestRequest().searchParams.get('from'), reviewSelection.from);
  assert.equal(latestRequest().searchParams.get('to'), reviewSelection.to);
  assert.equal(document.querySelectorAll('.conversation-cell').length, 94);
  assert.match(document.querySelector('.summary-stat-card').textContent, /94 de 94/);
  assert.match(document.querySelector('.review-selection-banner').textContent, /68 conversaciones se evaluaron antes de la corrección de horas/);
  for (const text of ['Ayer', '3 días', '30 días']) {
    await click(button(text));
    assert.equal(new URLSearchParams(router.state.location.search).get('reviewSelection'), 'all');
    assert.equal(latestRequest().searchParams.has('reviewSelection'), false);
    await click(button('Volver a la selección'));
    assert.equal(document.querySelectorAll('.conversation-cell').length, 94);
  }
  await click(button('Ver resumen habitual'));
  assert.equal(latestRequest().searchParams.has('reviewSelection'), false);
});

test('explicit filters avoid default selection and filtered selection keeps its honest denominator', async () => {
  await render('/?days=3&countries=HN');
  assert.equal(requests.some(url => url.searchParams.has('reviewSelection')), false);
  await act(async () => router.navigate('/?reviewSelection=review94&countries=HN'));
  assert.equal(document.querySelectorAll('.conversation-cell').length, 47);
  assert.match(document.querySelector('.summary-stat-card').textContent, /47 de 94/);
  for (const label of ['Crítico', 'Menor', 'Positivo', 'Refutado', 'Humano']) await click(document.querySelector(`button[aria-label="${label}"]`));
  assert.match(document.querySelector('.summary-stat-card').textContent, /0 de 94/);
  assert.equal(new URLSearchParams(router.state.location.search).get('reviewSelection'), 'review94');
  await click(button('Restablecer excepciones'));
  assert.equal(document.querySelectorAll('.conversation-cell').length, 47);
});

test('clearing the last explicit exception filter does not reactivate the default selection', async () => {
  await render('/?figures=critical');
  await click(button('Restablecer excepciones'));
  assert.equal(new URLSearchParams(router.state.location.search).get('reviewSelection'), 'all');
  assert.equal(requests.some(url => url.searchParams.has('reviewSelection')), false);
});

test('summary and history detail links retain the selection, filters and source-change warning', async () => {
  await render('/?reviewSelection=review94&countries=HN');
  const summaryUrl = `${router.state.location.pathname}${router.state.location.search}`;
  await click(document.querySelector('button[aria-label^="Abrir conversación de Cliente 0,"]'));
  assert.equal(latestRequest().searchParams.get('reviewSelection'), 'review94');
  assert.match(document.querySelector('#test').textContent, /La conversación cambió desde la evaluación/);
  assert.match(document.querySelector('#test').textContent, /Falta una revisión de modelo/);
  assert.match(document.querySelector('#test').textContent, /68 conversaciones se evaluaron antes de la corrección de horas/);
  await click(button('Resumen'));
  assert.equal(`${router.state.location.pathname}${router.state.location.search}`, summaryUrl);
  await click(document.querySelector('.country-title button'));
  assert.equal(router.state.location.pathname, '/historico');
  assert.equal(latestRequest().searchParams.get('reviewSelection'), 'review94');
  assert.equal(latestRequest().searchParams.get('country'), 'HN');
  assert.match(document.querySelector('.table-panel-head').textContent, /47 de 94/);
  assert.match(document.querySelector('thead').textContent, /DÍA DE SELECCIÓN/);
  assert.match(document.querySelector('[title^="Fecha y hora guardadas"]').textContent, /17(?: de)? nov/);
  const historyUrl = `${router.state.location.pathname}${router.state.location.search}`;
  await click(document.querySelector('.table-client'));
  assert.equal(latestRequest().searchParams.get('reviewSelection'), 'review94');
  await click(button('Histórico'));
  assert.equal(`${router.state.location.pathname}${router.state.location.search}`, historyUrl);
});

test('a legacy started-date link uses selection days while ordinary history keeps start dates', async () => {
  await render('/historico?reviewSelection=review94&dateBasis=started&from=2026-11-17&to=2026-11-19&country=HN');
  assert.equal(new URLSearchParams(router.state.location.search).get('dateBasis'), 'activity');
  assert.ok(requests.length > 0);
  assert.ok(requests.every(url => url.searchParams.get('dateBasis') === 'activity'), 'the first request also uses the saved selection day');
  assert.equal(latestRequest().searchParams.get('reviewSelection'), 'review94');
  assert.equal(latestRequest().searchParams.get('country'), 'HN');
  assert.match(document.querySelector('thead').textContent, /DÍA DE SELECCIÓN/);
  assert.doesNotMatch(document.querySelector('thead').textContent, /FECHA DE INICIO/);
  assert.match(document.querySelector('[title^="Fecha y hora guardadas"]').textContent, /17(?: de)? nov/);
  await act(async () => router.navigate('/historico?dateBasis=started'));
  assert.equal(latestRequest().searchParams.get('dateBasis'), 'started');
  assert.equal(latestRequest().searchParams.has('reviewSelection'), false);
  assert.match(document.querySelector('thead').textContent, /FECHA DE INICIO/);
});
