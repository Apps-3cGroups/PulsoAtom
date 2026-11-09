import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

// Render the actual JSX controls with React/Ant Design; no browser, server or
// provider is contacted. esbuild is the compiler already installed by Vite.
const require = createRequire(import.meta.url);
const folder = await mkdtemp(join(tmpdir(), 'pulso-manual-batch-ui-'));
let ManualBatchControls, JobModelProgress;
try {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/pages/Evaluations.jsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic',
    plugins: [{ name: 'existing-packages', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }],
  });
  const file = join(folder, 'Evaluations.mjs');
  await writeFile(file, result.outputFiles[0].text);
  ({ ManualBatchControls, JobModelProgress } = await import(pathToFileURL(file).href));
} finally { await rm(folder, { recursive: true, force: true }); }

const props = { max: 20, manualLimit: 100, reviewMode: 'local-dual', localDualAvailable: true, disabled: false };
const render = (Component, values) => renderToStaticMarkup(createElement(Component, values));
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
function nodes(element) {
  if (!element || typeof element !== 'object') return [];
  const children = [element.props?.children].flat(Infinity);
  return [element, ...children.flatMap(nodes)];
}

test('100 conversations previews 200 independent reviews in Gemma then Clef order without starting any request', () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('Rendering must not execute an evaluation'); };
  try {
    const html = render(ManualBatchControls, { ...props, max: 100 });
    assert.match(text(html), /Hasta 100 conversaciones · hasta 200 revisiones/);
    assert.match(text(html), /Primero Gemma y después Clef, sobre las mismas conversaciones/);
    assert.match(text(html), /Esta selección aplica solo a este lote/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('batch controls honor the API limit and cannot select unavailable local models', () => {
  const controls = nodes(ManualBatchControls({ ...props, manualLimit: 20, reviewMode: 'configured', localDualAvailable: false }));
  const size = controls.find(node => node.props?.id === 'manual-batch-size');
  const models = controls.find(node => node.props?.id === 'manual-batch-models');
  assert.deepEqual(size.props.options.map(option => option.value), [20]);
  assert.equal(models.props.options.find(option => option.value === 'local-dual').disabled, true);
  const copy = text(render(ManualBatchControls, { ...props, reviewMode: 'configured', localDualAvailable: false }));
  assert.match(copy, /Se utilizará la política de modelos guardada/);
  assert.doesNotMatch(copy, /40 revisiones/);
  assert.match(copy, /cuando ambos modelos locales estén habilitados/);
});

test('administrative or submit lock disables both selectors, while draft changes only call their own setter', () => {
  const changes = [];
  const controls = nodes(ManualBatchControls({ ...props, disabled: true, onMaxChange: value => changes.push(['max', value]), onReviewModeChange: value => changes.push(['mode', value]) }));
  const size = controls.find(node => node.props?.id === 'manual-batch-size');
  const models = controls.find(node => node.props?.id === 'manual-batch-models');
  assert.equal(size.props.disabled, true);
  assert.equal(models.props.disabled, true);
  size.props.onChange(100);
  models.props.onChange('configured');
  assert.deepEqual(changes, [['max', 100], ['mode', 'configured']]);
});

test('model stages use actual task states, retaining technical incidents without confusing them with pending Clef', () => {
  const job = {
    executionOrder: 'model-first',
    modelProfiles: [{ id: 'gemma-local', label: 'Gemma' }, { id: 'clef-local', label: 'Clef' }],
    modelProgress: [
      { profileId: 'gemma-local', label: 'Gemma', total: 100, completed: 98, partial: 1, failed: 1, running: 0, pending: 0 },
      { profileId: 'clef-local', label: 'Clef', total: 100, completed: 2, partial: 0, failed: 0, running: 1, pending: 97 },
    ],
  };
  const copy = text(render(JobModelProgress, { job }));
  assert.match(copy, /Gemma → Clef/);
  assert.match(copy, /Gemma 100\/100 Terminada con incidencias 2 con incidencias/);
  assert.match(copy, /Clef 2\/100 En curso/);
  job.modelProgress[1] = { ...job.modelProgress[1], completed: 0, running: 0, pending: 100 };
  assert.match(text(render(JobModelProgress, { job })), /Clef 0\/100 Pendiente/);
});
