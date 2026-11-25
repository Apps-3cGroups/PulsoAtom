import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dom, h, act, createRoot, ConfigProvider, Marks, CompactSummaryMap, root;
const day = '2026-11-18';
const base = { id: 'a', evaluated: true, evaluationStatus: 'evaluated', bothModelsComplete: true,
  client: { name: 'Caso A' }, displayAt: `${day}T15:00:00Z`, country: 'HN', marks: [] };
const human = { id: 'historical', name: 'Revisión humana guardada', kind: 'human', classification: 'critical', effective: true, origin: 'human', dualDetected: false };
const currentMark = { id: 'current', name: 'Coincidencia vigente', kind: 'critical', classification: 'critical', effective: true, dualDetected: true };
const propsFor = conversations => ({ groups: [{ code: 'HN', name: 'Honduras', agents: [{ id: 'agent', name: 'Asistente', byDay: { [day]: conversations } }] }],
  days: [day], visible: ['critical', 'normal', 'positive', 'refuted', 'human'], classification: 'all', onOpen() {}, onHistory() {} });

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><main id="test"></main></body></html>', { url: 'http://localhost/pulsoAtom/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLBodyElement', 'Element', 'SVGElement', 'ShadowRoot', 'Node', 'MutationObserver']) globalThis[key] = dom.window[key];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.getComputedStyle = element => dom.window.getComputedStyle(element);
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  dom.window.matchMedia = query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  ({ createElement: h, act } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  ({ ConfigProvider } = await import('antd'));
  const require = createRequire(import.meta.url), folder = await mkdtemp(join(tmpdir(), 'pulso-source-state-'));
  try {
    const result = await build({ stdin: { contents: "export {Marks} from './components/common.jsx'; export {default as CompactSummaryMap} from './components/CompactSummaryMap.jsx';", resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) },
      bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' },
      plugins: [{ name: 'packages', setup(builder) { builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true })); } }] });
    const file = join(folder, 'components.mjs'); await writeFile(file, result.outputFiles[0].text);
    ({ Marks, CompactSummaryMap } = await import(pathToFileURL(file).href));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; });
after(() => dom?.window.close());
async function render(component, props) {
  root = createRoot(document.querySelector('#test'));
  await act(async () => root.render(h(ConfigProvider, { theme: { token: { motion: false } } }, h(component, props))));
}
async function click(element) { assert.ok(element); await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); }

test('table marks identify updated data even with a historical human mark', async () => {
  const conversation = { ...base, sourceChanged: true, marks: [human] }, saved = structuredClone(conversation);
  await render(Marks, { conversation });
  assert.match(document.querySelector('#test').textContent, /Datos actualizados/);
  assert.match(document.querySelector('#test').textContent, /Flags automáticos pendientes de validar/);
  assert.doesNotMatch(document.querySelector('#test').textContent, /Contenido nuevo|Sin flags/);
  assert.ok(document.querySelector('[aria-label="Flag humano"]'));
  assert.equal(document.querySelectorAll('.dual-badge').length, 0);
  assert.deepEqual(conversation, saved);
});

test('historical labels retain unfinished model execution incidents', async () => {
  await render(Marks, { conversation: { ...base, sourceChanged: true, evaluationStatus: 'review_pending' } });
  assert.match(document.querySelector('#test').textContent, /Datos actualizados/);
  assert.match(document.querySelector('#test').textContent, /Falta una revisión de modelo/);
  assert.match(document.querySelector('#test').textContent, /Flags automáticos pendientes de validar/);
});

test('compact empty historical cell has explicit freshness text, not a clean or pending-execution status', async () => {
  await render(CompactSummaryMap, propsFor([{ ...base, evaluation: { sourceChanged: true } }]));
  const cell = document.querySelector('.compact-conversation');
  assert.ok(cell.classList.contains('is-source-changed'));
  assert.equal(cell.classList.contains('is-pending'), false);
  assert.match(cell.getAttribute('aria-label'), /Resultados históricos · datos actualizados/);
  assert.match(cell.getAttribute('aria-label'), /Flags automáticos pendientes de validar/);
  assert.doesNotMatch(cell.getAttribute('aria-label'), /sin flags visibles/);
});

test('mixed compact group distinguishes old human marks from current results and preserves navigation', async () => {
  const changed = { ...base, sourceChanged: true, marks: [human] };
  const current = { ...base, id: 'b', client: { name: 'Caso B' }, marks: [currentMark] };
  let opened;
  await render(CompactSummaryMap, { ...propsFor([changed, current]), onOpen: conversation => { opened = conversation.id; } });
  const cell = document.querySelector('.compact-conversation');
  assert.ok(cell.classList.contains('is-group'));
  assert.ok(cell.classList.contains('is-source-changed'));
  assert.ok(cell.classList.contains('is-dual'), 'the current member retains its valid detection');
  assert.match(cell.getAttribute('aria-label'), /1 de 2 con datos actualizados/);
  await click(cell);
  const entries = [...document.querySelectorAll('.compact-group-list > button')];
  assert.equal(entries.length, 2);
  assert.ok(entries[0].classList.contains('has-source-change'));
  assert.match(entries[0].textContent, /Resultados históricos · datos actualizados/);
  assert.match(entries[0].textContent, /Marcas históricas: Revisión humana guardada/);
  assert.equal(entries[1].classList.contains('has-source-change'), false);
  assert.match(entries[1].textContent, /Evaluada/);
  await click(entries[0]); assert.equal(opened, 'a');
});
