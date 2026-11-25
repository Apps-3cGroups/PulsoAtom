import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dom, h, act, createRoot, createMemoryRouter, RouterProvider, ConfigProvider, Conversation, PortalContext, root, router, conversation;
const originalFetch = globalThis.fetch;
const scrolls = [];
before(async () => {
  dom = new JSDOM('<!doctype html><html><body><main id="test"></main></body></html>', { url: 'http://localhost/pulsoAtom/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLBodyElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'SVGElement', 'ShadowRoot', 'Node', 'MutationObserver', 'FormData']) globalThis[key] = dom.window[key];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.getComputedStyle = element => dom.window.getComputedStyle(element);
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.MessageChannel = dom.window.MessageChannel;
  dom.window.matchMedia = query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = function () { scrolls.push(this.id); };
  ({ createElement: h, act } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  ({ createMemoryRouter, RouterProvider } = await import('react-router-dom'));
  ({ ConfigProvider } = await import('antd'));
  const require = createRequire(import.meta.url), folder = await mkdtemp(join(tmpdir(), 'pulso-message-flags-'));
  try {
    const result = await build({ stdin: { contents: "export {default as Conversation} from './pages/Conversation.jsx'; export {PortalContext} from './hooks.js';", resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) },
      bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' },
      plugins: [{ name: 'packages', setup(builder) {
        builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
      } }] });
    const file = join(folder, 'conversation.mjs');
    await writeFile(file, result.outputFiles[0].text);
    ({ Conversation, PortalContext } = await import(pathToFileURL(file).href));
  } finally { await rm(folder, { recursive: true, force: true }); }
  globalThis.fetch = async input => {
    assert.match(String(input), /\/conversations\/synthetic/);
    return new Response(JSON.stringify({ conversation }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  router?.dispose(); root = null; router = null; scrolls.length = 0;
});
after(() => { globalThis.fetch = originalFetch; dom?.window.close(); });

function fixture(historical) {
  const messages = [
    { id: 'one', actor: 'cliente', text: 'Primer mensaje original.' },
    { id: 'two', actor: 'humano', text: 'Segundo mensaje original.' },
    { id: 'three', actor: 'bot', text: 'Tercer mensaje original.' },
  ].map(message => ({ ...message, timestamp: '2026-11-18T15:00:00Z' }));
  const variables = [['first', 'Primer flag', messages.slice(0, 2)], ['second', 'Segundo flag', messages.slice(2)]].map(([id, name, cited]) => {
    const result = { status: 'evaluado', value: 1, method: 'IA', type: 'Flag', reason: 'Justificación guardada.',
      evidence: cited.map(message => ({ messageId: message.id, quote: message.text })) };
    return { id, name, version: 1, type: 'Flag', method: 'IA', family: 'Familia de prueba', definition: 'Criterio original.',
      enabledInEvaluation: true, classification: 'critical', kind: historical ? null : 'critical', effective: !historical,
      historicalAutomaticFlagVisible: historical, historicalKind: historical ? 'critical' : null, dualDetected: !historical,
      result: { ...result, comparison: { agreement: 'agree-positive', sourceChanged: historical, detections: 2, votes: 2, expected: 2,
        cells: ['Clef', 'Gemma'].map(label => ({ profileId: label, label, model: `synthetic-${label}`, status: 'completed', result })) } } };
  });
  return { id: 'synthetic', country: 'HN', countryName: 'Honduras', displayTimezone: 'America/Tegucigalpa',
    date: '2026-11-18', activityAt: '2026-11-18T15:00:00Z', startedAt: '2026-11-18T15:00:00Z', channel: 'WhatsApp',
    agent: { name: 'Asesor de prueba' }, client: { name: 'Cliente de prueba' }, topics: [], media: [], reviews: [],
    variables, messages, evaluated: true, evaluationStatus: 'evaluated', sourceChanged: historical, historicalFlagsAvailable: historical,
    evaluation: { sourceChanged: historical, evaluatedCount: 2, modelReviews: [] } };
}
async function render(value) {
  conversation = value;
  router = createMemoryRouter([{ path: '/conversacion/:id', element: h(Conversation) }], { initialEntries: ['/conversacion/synthetic'] });
  root = createRoot(document.querySelector('#test'));
  await act(async () => root.render(h(ConfigProvider, { theme: { token: { motion: false } } },
    h(PortalContext.Provider, { value: { bootstrap: { timezone: 'America/Tegucigalpa' }, user: { role: 'supervisor' } } }, h(RouterProvider, { router })))));
}
async function click(element) {
  assert.ok(element, 'Expected actionable element');
  await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
}
const highlighted = () => [...document.querySelectorAll('.message-row-highlighted')].map(element => element.dataset.messageId);

for (const historical of [false, true]) test(`${historical ? 'historical verified' : 'current'} flag selection scrolls and stays highlighted until another selection or explicit clearing`, async () => {
  await render(fixture(historical));
  const first = document.querySelector('[aria-label="Resaltar mensajes de Primer flag"]');
  await click(first);
  assert.deepEqual(highlighted(), ['one', 'two']);
  assert.equal(first.getAttribute('aria-pressed'), 'true');
  assert.equal(scrolls.at(-1), 'message-one');
  await click(document.querySelector('[aria-label="Siguiente mensaje del flag seleccionado"]'));
  assert.equal(scrolls.at(-1), 'message-two');
  assert.deepEqual(highlighted(), ['one', 'two']);
  await click(document.querySelector('[aria-label="Ver revisión de Primer flag"]'));
  assert.deepEqual(highlighted(), ['one', 'two']);
  assert.match(document.querySelector('.ant-drawer .conversation-flag-details').textContent, /Mensajes vinculados \(2\)/);
  await click(document.querySelector('.ant-drawer-close'));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  assert.deepEqual(highlighted(), ['one', 'two']);
  await click(document.querySelector('[aria-label="Resaltar mensajes de Segundo flag"]'));
  assert.deepEqual(highlighted(), ['three']);
  assert.equal(scrolls.at(-1), 'message-three');
  await click(document.querySelector('[aria-label="Quitar selección de flag"]'));
  assert.deepEqual(highlighted(), []);
});

test('verified historical drawer links return to the original message with persistent focus and no review authorization', async () => {
  await render(fixture(true));
  await click(document.querySelector('[aria-label="Ver revisión de Primer flag"]'));
  const linked = [...document.querySelectorAll('.ant-drawer button.evidence-quote')].find(element => element.textContent.includes('Segundo mensaje original.'));
  await click(linked);
  assert.equal(document.querySelector('.ant-drawer-open'), null);
  assert.deepEqual(highlighted(), ['two']);
  assert.equal(scrolls.at(-1), 'message-two');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  assert.deepEqual(highlighted(), ['two']);
  await click(document.querySelector('[aria-label="Ver revisión de Primer flag"]'));
  assert.equal(document.querySelector('.flag-details-heading .ant-btn'), null);
});

test('altered or missing historical evidence opens the saved review without highlighting unrelated current text', async () => {
  const value = fixture(true);
  value.messages[0].text = 'Primer mensaje editado.';
  value.messages[1].id = 'replacement';
  await render(value);
  assert.equal(document.querySelector('[aria-label="Resaltar mensajes de Primer flag"]'), null);
  await click(document.querySelector('[aria-label="Ver revisión de Primer flag, sin mensaje vinculable"]'));
  assert.deepEqual(highlighted(), []);
  assert.equal(scrolls.length, 0);
  assert.match(document.querySelector('.ant-drawer .conversation-flag-details').textContent, /Mensajes vinculados \(0\)/);
  assert.equal(document.querySelectorAll('.ant-drawer button.evidence-quote').length, 0);
  assert.match(document.querySelector('.ant-drawer .conversation-flag-details').textContent, /Primer mensaje original/);
});
