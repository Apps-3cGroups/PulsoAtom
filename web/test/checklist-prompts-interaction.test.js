import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dom, h, act, useState, createRoot, ChecklistPrompts, ConfigProvider, root;
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
  ({ createElement: h, act, useState } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  ({ ConfigProvider } = await import('antd'));
  const require = createRequire(import.meta.url);
  const folder = await mkdtemp(join(tmpdir(), 'pulso-checklist-prompts-'));
  try {
    const result = await build({ entryPoints: [fileURLToPath(new URL('../src/components/ChecklistPrompts.jsx', import.meta.url))],
      bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic',
      plugins: [{ name: 'packages', setup(builder) {
        builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
      } }],
    });
    const file = join(folder, 'ChecklistPrompts.mjs');
    await writeFile(file, result.outputFiles[0].text);
    ({ default: ChecklistPrompts } = await import(pathToFileURL(file).href));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; });
after(() => dom?.window.close());

const flag = { id: 'flag', name: 'Queja de prueba', method: 'IA', type: 'Flag', active: true, version: 1,
  definition: 'Detectar la queja visible.', condition: 'Incluir experiencias anteriores.' };
async function render(byItem = {}) {
  const changes = [];
  function Harness() {
    const [prompts, setPrompts] = useState({ byItem });
    return h(ChecklistPrompts, { checklist: [flag, { ...flag, id: 'code', name: 'Métrica por código', method: 'Código' }], prompts,
      onChange: next => { changes.push(structuredClone(next)); setPrompts({ byItem: next }); } });
  }
  root = createRoot(document.querySelector('#test'));
  await act(async () => root.render(h(ConfigProvider, { theme: { token: { motion: false } } }, h(Harness))));
  return changes;
}
async function click(element) {
  assert.ok(element);
  await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
}
async function input(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function selectMode(text) {
  await click(document.querySelector('.ant-drawer .ant-select-selector'));
  const option = [...document.querySelectorAll('.ant-select-item-option')].find(e => e.textContent === text);
  assert.ok(option);
  for (const type of ['mousedown', 'mouseup', 'click']) await act(async () => option.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true })));
}

test('opening a flag displays its catalog prompt without changing the draft; editing creates a shared prompt', async () => {
  const changes = await render();
  assert.equal(document.querySelector('button[aria-label="Editar prompt de Métrica por código"]').disabled, true);
  await click(document.querySelector('button[aria-label="Editar prompt de Queja de prueba"]'));
  const field = document.querySelector('textarea[aria-label="Prompt base del ítem"]');
  assert.ok(field.value.includes(flag.definition) && field.value.includes(flag.condition));
  assert.deepEqual(changes, []);
  await input(field, `${field.value}\nCriterio personalizado.`);
  assert.equal(changes.at(-1).flag.mode, 'shared');
  assert.match(changes.at(-1).flag.shared, /Criterio personalizado/);
  await input(document.querySelector('textarea[aria-label="Prompt compartido del ítem"]'), '');
  assert.equal(document.querySelector('textarea[aria-label="Prompt compartido del ítem"]').value, '');
});

test('choosing model-specific prompts fills both fields and preserves their separate edits across mode changes', async () => {
  const changes = await render({ flag: { mode: 'inherit', shared: '', byModel: { 'clef-local': '', 'gemma-local': '' } } });
  await click(document.querySelector('button[aria-label="Editar prompt de Queja de prueba"]'));
  await selectMode('Por modelo');
  const clef = document.querySelector('textarea[aria-label="Prompt del ítem para Clef"]');
  const gemma = document.querySelector('textarea[aria-label="Prompt del ítem para Gemma"]');
  assert.ok(clef.value.includes(flag.definition));
  assert.equal(clef.value, gemma.value);
  const originalGemma = gemma.value;
  await input(clef, 'Personalizado para Clef');
  await selectMode('Del catálogo');
  await selectMode('Por modelo');
  assert.equal(document.querySelector('textarea[aria-label="Prompt del ítem para Clef"]').value, 'Personalizado para Clef');
  assert.equal(document.querySelector('textarea[aria-label="Prompt del ítem para Gemma"]').value, originalGemma);
  assert.equal(changes.at(-1).flag.mode, 'per-model');
});
