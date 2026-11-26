import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { transformWithEsbuild } from 'vite';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

let dom, h, act, createRoot, Select, ConfigProvider, Form, root;
before(async () => {
  dom = new JSDOM('<!doctype html><html><body><main id="test"></main></body></html>', { url: 'http://localhost/pulsoAtom/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'SVGElement', 'ShadowRoot', 'Node', 'MutationObserver']) globalThis[key] = dom.window[key];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.getComputedStyle = element => dom.window.getComputedStyle(element);
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no browser MessageChannel. Use rc-overflow's RAF fallback;
  // Node worker MessagePorts otherwise keep the test process alive after cleanup.
  globalThis.MessageChannel = dom.window.MessageChannel;
  dom.window.matchMedia = query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  ({ createElement: h, act } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  ({ ConfigProvider, Form } = await import('antd'));
  const path = fileURLToPath(new URL('../src/components/Select.jsx', import.meta.url));
  const compiled = await transformWithEsbuild(await readFile(path, 'utf8'), path, { loader: 'jsx', jsx: 'automatic' });
  const require = createRequire(import.meta.url);
  const code = compiled.code.replace(/from ["']([^"']+)["']/g, (_match, name) => `from ${JSON.stringify(pathToFileURL(require.resolve(name)).href)}`);
  ({ default: Select } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; });
after(() => dom?.window.close());

const options = [{ value: 'PA', label: 'Panamá' }, { value: 'HN', label: 'Honduras' }, { value: 'MX', label: 'México' }];
async function render(props = {}, formDisabled = false) {
  root = createRoot(document.querySelector('#test'));
  await act(async () => root.render(h(ConfigProvider, { theme: { token: { motion: false } } },
    h(Form, { disabled: formDisabled }, h(Select, { 'aria-label': 'País', options, placeholder: 'Selecciona', ...props })))));
}
const input = () => document.querySelector('input[role="combobox"]');
const expanded = () => input().getAttribute('aria-expanded') === 'true';
async function event(target, name, details = {}) {
  await act(async () => target.dispatchEvent(new dom.window.MouseEvent(name, { bubbles: true, cancelable: true, ...details })));
}
async function mouseClick(target) { for (const name of ['mousedown', 'mouseup', 'click']) await event(target, name, { detail: 1 }); }

test('a completed click without mousedown opens text, padding and arrow; real options remain selectable', async () => {
  for (const target of ['.ant-select-selector', '.ant-select-selection-placeholder', '.ant-select-arrow']) {
    let selected;
    await render({ onChange: value => { selected = value; } });
    await event(document.querySelector(target), 'click');
    assert.equal(expanded(), true, target);
    assert.match(document.querySelector('.ant-select-dropdown').textContent, /Panamá.*Honduras.*México/);
    await mouseClick([...document.querySelectorAll('.ant-select-item-option')].find(option => option.textContent === 'Panamá'));
    assert.equal(selected, 'PA');
    assert.equal(expanded(), false, 'selecting a portaled option does not reopen');
    await act(async () => root.unmount()); root = null;
  }
});

test('ordinary mouse clicks toggle once; keyboard navigation and escape remain available', async () => {
  await render();
  await mouseClick(document.querySelector('.ant-select-selector'));
  assert.equal(expanded(), true);
  await mouseClick(document.querySelector('.ant-select-selector'));
  assert.equal(expanded(), false);
  await act(async () => input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, which: 40, bubbles: true })));
  assert.equal(expanded(), true);
  await act(async () => input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true })));
  assert.equal(expanded(), false);
});

test('a click without pointer input opens after an earlier pointer gesture closed the menu without a click', async () => {
  await render();
  const trigger = document.querySelector('.ant-select-selector');
  await mouseClick(trigger);
  assert.equal(expanded(), true);
  await event(trigger, 'mousedown', { detail: 1 });
  assert.equal(expanded(), false);
  await event(trigger, 'click', { detail: 0 });
  assert.equal(expanded(), true);
});

test('multiple selection, removing tags and clearing do not reopen a closed list', async () => {
  let value;
  await render({ mode: 'multiple', allowClear: true, defaultValue: ['PA', 'HN'], onChange: next => { value = next; } });
  await mouseClick(document.querySelector('.ant-select-selection-item-remove'));
  assert.deepEqual(value, ['HN']);
  assert.equal(expanded(), false);
  await mouseClick(document.querySelector('.ant-select-clear'));
  assert.deepEqual(value, []);
  assert.equal(expanded(), false);
});

test('explicit and inherited form disability prevent opening', async () => {
  for (const inherited of [false, true]) {
    await render(inherited ? {} : { disabled: true }, inherited);
    await event(document.querySelector('.ant-select-selector'), 'click');
    assert.equal(expanded(), false);
    await act(async () => root.unmount()); root = null;
  }
});
