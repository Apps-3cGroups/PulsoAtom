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
async function selectMode(value) {
  await click(document.querySelector(`input[type="radio"][value="${value}"]`));
}

test('opening a flag displays its catalog prompt without changing the draft; editing creates a shared prompt', async () => {
  const changes = await render();
  assert.equal(document.querySelector('button[aria-label="Editar prompt de Métrica por código"]'), null);
  const codeRow = [...document.querySelectorAll('tr')].find(row => row.textContent.includes('Métrica por código'));
  assert.match(codeRow.textContent, /Código.*No utiliza prompt.*Fórmula o regla de código/);
  await click(document.querySelector('button[aria-label="Editar prompt de Queja de prueba"]'));
  const field = document.querySelector('textarea[aria-label="Prompt para Clef y Gemma"]');
  assert.ok(field.value.includes(flag.definition) && field.value.includes(flag.condition));
  assert.deepEqual(changes, []);
  assert.equal(document.querySelectorAll('input[type="radio"]').length, 2);
  assert.equal(document.querySelector('input[value="shared"]').checked, true);
  await input(field, `${field.value}\nCriterio personalizado.`);
  assert.equal(changes.at(-1).flag.mode, 'shared');
  assert.equal(changes.at(-1).flag.application, 'replace');
  assert.match(changes.at(-1).flag.shared, /Criterio personalizado/);
  await input(document.querySelector('textarea[aria-label="Prompt para Clef y Gemma"]'), '');
  assert.equal(document.querySelector('textarea[aria-label="Prompt para Clef y Gemma"]').value, '');
});

test('choosing model-specific prompts fills both fields and preserves their separate edits across mode changes', async () => {
  const changes = await render({ flag: { mode: 'inherit', shared: '', byModel: { 'clef-local': '', 'gemma-local': '' } } });
  await click(document.querySelector('button[aria-label="Editar prompt de Queja de prueba"]'));
  await selectMode('per-model');
  const clef = document.querySelector('textarea[aria-label="Prompt para Clef"]');
  const gemma = document.querySelector('textarea[aria-label="Prompt para Gemma"]');
  assert.ok(clef.value.includes(flag.definition));
  assert.equal(clef.value, gemma.value);
  const originalGemma = gemma.value;
  await input(clef, 'Personalizado para Clef');
  await selectMode('shared');
  await selectMode('per-model');
  assert.equal(document.querySelector('textarea[aria-label="Prompt para Clef"]').value, 'Personalizado para Clef');
  assert.equal(document.querySelector('textarea[aria-label="Prompt para Gemma"]').value, originalGemma);
  assert.equal(changes.at(-1).flag.mode, 'per-model');
});

test('existing independent criteria reopen unchanged and restoring the catalog resets both models explicitly', async () => {
  const changes = await render({ flag: { application: 'replace', mode: 'per-model', shared: '',
    byModel: { 'clef-local': 'Criterio guardado Clef', 'gemma-local': 'Criterio guardado Gemma' } } });
  await click(document.querySelector('button[aria-label="Editar prompt de Queja de prueba"]'));
  assert.equal(document.querySelector('textarea[aria-label="Prompt para Clef"]').value, 'Criterio guardado Clef');
  assert.equal(document.querySelector('textarea[aria-label="Prompt para Gemma"]').value, 'Criterio guardado Gemma');
  assert.deepEqual(changes, []);
  await click([...document.querySelectorAll('.ant-drawer button')].find(button => button.textContent === 'Restaurar texto del catálogo'));
  assert.equal(changes.at(-1).flag.mode, 'inherit');
  assert.equal(document.querySelectorAll('.ant-drawer textarea').length, 1);
  assert.ok(document.querySelector('textarea').value.includes(flag.definition));
  await selectMode('per-model');
  for (const field of document.querySelectorAll('.ant-drawer textarea')) {
    assert.ok(field.value.includes(flag.definition) && field.value.includes(flag.condition));
    assert.ok(!field.value.includes('Criterio guardado'));
  }
  await click([...document.querySelectorAll('.ant-drawer button')].find(button => button.textContent === 'Volver a configuración'));
  assert.equal(document.querySelector('.ant-drawer-open'), null);
});
