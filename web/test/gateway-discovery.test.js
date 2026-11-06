import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayDiscovery } from '../src/services/gatewayDiscovery.js';

const tools = { tools: [{ key: 'saved-clef', status: 'active' }, { key: 'saved-gemma', status: 'active' }] };
const tick = () => new Promise(resolve => setImmediate(resolve));
function pendingReader() {
  const calls = [];
  // Deliberately ignore AbortSignal to prove the identity checks also work when
  // a response was already received at the moment the selection was changed.
  return { calls, request: (path, options) => new Promise((resolve, reject) => calls.push({ path, options, resolve, reject })) };
}

test('a catalog refresh automatically loads selected saved tools, deduplicates shared tools and only reads', async () => {
  let state;
  const calls = [];
  const discovery = createGatewayDiscovery({ onChange: next => { state = next; }, request: async (path, options) => {
    calls.push({ path, options });
    return path.endsWith('/tools') ? tools : { models: [path.includes('saved-clef') ? 'clef-model' : 'gemma-model'] };
  } });
  discovery.select(['saved-clef', 'saved-gemma', 'saved-clef']);
  discovery.start();
  await discovery.refresh();
  assert.deepEqual(calls.map(c => c.path), ['/models/gateway/tools', '/models/gateway/tools/saved-clef/models', '/models/gateway/tools/saved-gemma/models']);
  assert.deepEqual(state.models['saved-clef'].items, ['clef-model']);
  assert.deepEqual(state.models['saved-gemma'].items, ['gemma-model']);
  assert.ok(calls.every(c => !c.options.method && !c.options.body));
  await discovery.refresh();
  assert.equal(calls.length, 6);
  discovery.stop();
});

test('an empty selection never guesses a tool or model, while later selection loads without another catalog click', async () => {
  let state;
  const calls = [];
  const discovery = createGatewayDiscovery({ onChange: next => { state = next; }, request: async path => {
    calls.push(path); return path.endsWith('/tools') ? tools : { models: ['published-id'] };
  } });
  discovery.start(); discovery.select(['', undefined]);
  await discovery.refresh();
  assert.equal(calls.length, 1); assert.deepEqual(state.models, {});
  discovery.select(['saved-clef']); await tick();
  assert.equal(calls.length, 2); assert.deepEqual(state.models['saved-clef'].items, ['published-id']);
  discovery.stop();
});

test('changing or resetting the selected tool ignores late responses and aborts obsolete model reads', async () => {
  let state;
  const { request, calls } = pendingReader();
  const discovery = createGatewayDiscovery({ request, onChange: next => { state = next; } });
  discovery.start(); discovery.select(['saved-clef']);
  const initial = discovery.refresh();
  calls[0].resolve(tools); await tick();
  discovery.select(['saved-gemma']);
  assert.equal(calls[1].options.signal.aborted, true);
  calls[1].resolve({ models: ['obsolete-clef'] }); await tick();
  assert.equal(state.models['saved-clef'], undefined);
  assert.equal(state.models['saved-gemma'].status, 'loading');
  // Reset the form to the originally saved tool while Gemma is still pending.
  discovery.select(['saved-clef']);
  assert.equal(calls[2].options.signal.aborted, true);
  calls[2].resolve({ models: ['obsolete-gemma'] }); await tick();
  assert.equal(state.models['saved-gemma'], undefined);
  calls[3].resolve({ models: ['current-clef'] }); await tick();
  assert.deepEqual(state.models['saved-clef'].items, ['current-clef']);
  await initial; discovery.stop();
});

test('stop/start like StrictMode can restart discovery without accepting the first mount response or leaving loading stuck', async () => {
  let state, notifications = 0;
  const { request, calls } = pendingReader();
  const discovery = createGatewayDiscovery({ request, onChange: next => { state = next; notifications++; } });
  discovery.start(); discovery.select(['saved-clef']);
  const first = discovery.refresh();
  discovery.stop(); assert.equal(calls[0].options.signal.aborted, true);
  discovery.start(); const second = discovery.refresh();
  calls[0].resolve({ tools: [{ key: 'wrong-tool', status: 'active' }] }); await tick();
  assert.equal(state.toolsStatus, 'loading'); assert.equal(calls.length, 2);
  calls[1].resolve(tools); await tick();
  calls[2].resolve({ models: ['correct-model'] }); await second; await first;
  assert.equal(state.toolsStatus, 'ready'); assert.equal(state.models['saved-clef'].status, 'ready');
  discovery.stop(); const count = notifications;
  await discovery.refresh(); assert.equal(notifications, count);
});

test('errors and empty model lists remain explicit and can be retried without a form change', async () => {
  let state, attempts = 0;
  const discovery = createGatewayDiscovery({ onChange: next => { state = next; }, request: async path => {
    if (path.endsWith('/tools')) return tools;
    attempts++;
    if (attempts === 1) throw new Error('Herramienta sin respuesta');
    return { models: attempts === 2 ? [] : ['available-model'] };
  } });
  discovery.start(); discovery.select(['saved-clef']); await discovery.refresh();
  assert.equal(state.models['saved-clef'].status, 'error');
  assert.equal(state.models['saved-clef'].error.message, 'Herramienta sin respuesta');
  await discovery.retry('saved-clef'); assert.deepEqual(state.models['saved-clef'].items, []);
  await discovery.retry('saved-clef'); assert.deepEqual(state.models['saved-clef'].items, ['available-model']);
  discovery.stop();
});

test('a saved tool removed from the catalog is explained and never invoked until it is active again', async () => {
  let state, active = false;
  const calls = [];
  const discovery = createGatewayDiscovery({ onChange: next => { state = next; }, request: async path => {
    calls.push(path); return path.endsWith('/tools') ? { tools: active ? tools.tools : [] } : { models: ['restored-model'] };
  } });
  discovery.start(); discovery.select(['saved-clef']); await discovery.refresh();
  assert.equal(state.models['saved-clef'].status, 'error'); assert.equal(calls.length, 1);
  active = true; await discovery.retry('saved-clef');
  assert.equal(calls.length, 3); assert.deepEqual(state.models['saved-clef'].items, ['restored-model']);
  discovery.stop();
});
