import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createState } from '../src/data/seed.js';
import { ModelRegistry } from '../src/model-registry.js';
import { createGemmaBackfillPlan, executeGemmaBackfill, extendGemmaBackfillPlan, inspectGemmaBackfill, persistBackfillManifest, acquireBackfillLock } from '../src/gemma-backfill.js';
import { extendGemmaRenewal, parseGemmaExtensionArguments } from '../scripts/extend-gemma-renewal.js';
import { parseGemmaRenewalArguments } from '../scripts/start-gemma-renewal.js';

const id = '77f134e8-fdf8-4154-b1f6-485c159b9194';
const selection = { from: '2026-11-02', to: '2026-11-06', timezone: 'America/Tegucigalpa', basis: 'last_activity', limit: 20 };
const larger = { ...selection, from: '1970-01-01', limit: 500 };
async function fixture({ total = 500, initial = 20, partial = false } = {}) {
  const state = createState(false);
  state.catalog = state.catalog.filter(v => ['cliente_molesto', 'cliente_pidio_supervisor'].includes(v.id));
  state.catalog.forEach(v => { v.active = true; });
  state.catalogVersions = state.catalog.map(v => ({ itemId: v.id, version: v.version, snapshot: structuredClone(v) }));
  state.settings = { ...state.settings, dailyEnabled: false, evaluationMaintenance: id,
    aiPolicy: { mode: 'single', primaryId: 'gemma-local', secondaryId: null, fallbackId: null, version: 6 } };
  state.conversations = Array.from({ length: total }, (_, index) => ({ id: String(index + 1), country: 'HN', completed: index % 2 === 0,
    lastActivityAt: '2026-11-05T12:00:00.000Z', messages: [{ id: `m${index + 1}`, actor: 'cliente', text: 'PRIVATE_SYNTHETIC_TEXT', timestamp: '2026-11-05T12:00:00.000Z' }] }));
  const control = { partial }, calls = [];
  const registry = new ModelRegistry([{ id: 'gemma-local', provider: 'gateway', model: 'synthetic-gemma', label: 'Gemma', enabled: true,
    evaluator: { configured: true, async evaluate(conversation, variables) {
      calls.push({ id: conversation.id, variables: variables.map(v => v.id) });
      const invalid = v => control.partial && [String(total), String(total - 1)].includes(conversation.id) && v.id === 'cliente_pidio_supervisor';
      return { model: 'synthetic-gemma', results: variables.filter(v => !invalid(v)).map(v => ({ variableId: v.id, status: 'evaluado', value: 0,
        reason: 'Evento ausente en el ejemplo sintético.', evidence: [] })),
        validationErrors: variables.filter(invalid).map(v => ({ variableId: v.id, code: 'INVALID_AI_RESULT', rules: ['invalid_reason'] })) };
    } } }]);
  const store = { async read() { return structuredClone(state); }, async readWithConversations() { return structuredClone(state); },
    async transaction(fn) { const draft = structuredClone(state), result = await fn(draft); Object.assign(state, draft); return structuredClone(result); } };
  const manifest = createGemmaBackfillPlan(state, registry, { maintenanceId: id, selection: { ...selection, limit: initial } });
  if (partial) await executeGemmaBackfill(store, registry, manifest, { maxBatches: 1 });
  return { state, registry, store, manifest, control, calls };
}

test('20 to 500 preserves eighteen complete results, two partial tasks, batches and original contexts; retry touches only pending items', async () => {
  const f = await fixture({ partial: true }), before = structuredClone(f.state), original = structuredClone(f.manifest);
  assert.equal(inspectGemmaBackfill(f.state, f.manifest).completed, 18);
  const extended = extendGemmaBackfillPlan(f.state, f.registry, f.manifest, { expectedTotal: 20, selection: larger });
  assert.equal(extended.conversations.length, 500); assert.equal(extended.revision.reusedCompleted, 18); assert.equal(extended.revision.retainedPending, 2);
  assert.equal(extended.revision.parentIntegrityHash, original.integrityHash); assert.notEqual(extended.integrityHash, original.integrityHash);
  assert.deepEqual(f.state, before); assert.deepEqual(f.manifest, original); assert.deepEqual(extended.batches, original.batches);
  for (const c of original.conversations) assert.deepEqual(extended.conversations.find(v => v.id === c.id), c);
  f.control.partial = false; const count = f.calls.length;
  const summary = await executeGemmaBackfill(f.store, f.registry, extended, { resume: true, maxBatches: 1 });
  assert.equal(summary.completed, 20); assert.equal(summary.pending, 480);
  assert.deepEqual(f.calls.slice(count).map(c => c.variables), [['cliente_pidio_supervisor'], ['cliente_pidio_supervisor']]);
  assert.deepEqual(f.state.evaluations.slice(0, before.evaluations.length), before.evaluations);
  assert.equal(f.state.tasks.length, 20); assert.equal(f.state.settings.dailyEnabled, false);
});

test('global latest selection can widen dates but rejects future activity, reduced scope, changed prior source and wrong totals', async () => {
  const f = await fixture({ total: 501 });
  f.state.conversations.find(c => c.id === '1').lastActivityAt = '2026-11-06T13:00:00.000Z';
  const extended = extendGemmaBackfillPlan(f.state, f.registry, f.manifest, { expectedTotal: 20, selection: larger, extendedAt: '2026-11-06T12:00:00.000Z' });
  assert.equal(extended.conversations.length, 500); assert.ok(!extended.conversations.some(c => c.id === '1'));
  for (const override of [{ expectedTotal: 19 }, { selection: { ...larger, limit: 20 } }, { selection: { ...larger, from: '2026-11-03' } }]) {
    assert.throws(() => extendGemmaBackfillPlan(f.state, f.registry, f.manifest, { expectedTotal: 20, selection: larger, ...override }));
  }
  f.state.conversations.find(c => c.id === '501').messages[0].text = 'changed';
  assert.throws(() => extendGemmaBackfillPlan(f.state, f.registry, f.manifest, { expectedTotal: 20, selection: larger }), { code: 'SOURCE_CHANGED' });
});

test('revision and scope are hash protected and insufficient/currently running cases cannot extend', async () => {
  const f = await fixture();
  const next = extendGemmaBackfillPlan(f.state, f.registry, f.manifest, { expectedTotal: 20, selection: larger });
  next.revision.parentIntegrityHash = '0'.repeat(64);
  assert.throws(() => inspectGemmaBackfill(f.state, next), { code: 'INVALID_BACKFILL_MANIFEST' });
  f.state.jobs.push({ status: 'running', maintenanceId: id, idempotencyKey: 'not-in-manifest' });
  assert.throws(() => extendGemmaBackfillPlan(f.state, f.registry, f.manifest, { expectedTotal: 20, selection: larger }));
  f.state.jobs = []; f.state.conversations.pop();
  assert.throws(() => extendGemmaBackfillPlan(f.state, f.registry, f.manifest, { expectedTotal: 20, selection: larger }), { code: 'INSUFFICIENT_CONVERSATIONS' });
});

test('CLI archives before replacing scope, releases the worker lock before spawn, never writes DB or invokes reset', async t => {
  const f = await fixture(), apiDirectory = await mkdtemp(path.join(os.tmpdir(), 'pulso-extend-test-'));
  t.after(() => rm(apiDirectory, { recursive: true, force: true }));
  const directory = path.join(apiDirectory, '.data/backfills'); await mkdir(directory, { recursive: true });
  const manifestFile = path.join(directory, `${id}.json`), operationFile = path.join(directory, `${id}.operation.json`);
  const oldOperation = { maintenanceId: id, status: 'started', pid: 123, total: 20, backup: '/synthetic/backup', backupSha256: 'a'.repeat(64) };
  await persistBackfillManifest(manifestFile, f.manifest); await persistBackfillManifest(operationFile, oldOperation);
  const before = structuredClone(f.state), oldText = await readFile(manifestFile, 'utf8'); let launches = 0;
  f.store.transaction = async () => assert.fail('Extension itself cannot mutate DB');
  const result = await extendGemmaRenewal({ ...f, apiDirectory, maintenanceId: id, expectedTotal: 20, selection: larger, env: {},
    launch: async () => {
      launches++; const release = await acquireBackfillLock(`${manifestFile}.lock`, id); await release();
      assert.equal(JSON.parse(await readFile(manifestFile, 'utf8')).conversations.length, 500);
      assert.equal(JSON.parse(await readFile(operationFile, 'utf8')).extension.status, 'starting');
      return { pid: 456 };
    } });
  assert.equal(result.destructive, false); assert.equal(result.added, 480); assert.equal(launches, 1);
  assert.equal(await readFile(result.archive, 'utf8'), oldText); assert.equal((await stat(result.archive)).mode & 0o777, 0o600);
  assert.deepEqual(f.state, before); assert.equal(f.calls.length, 0);
  const operation = JSON.parse(await readFile(operationFile, 'utf8'));
  assert.equal(operation.backup, oldOperation.backup); assert.equal(operation.backupSha256, oldOperation.backupSha256); assert.equal(operation.pid, 456);
  await assert.rejects(extendGemmaRenewal({ ...f, apiDirectory, maintenanceId: id, expectedTotal: 20, selection: larger }), { code: 'BACKFILL_TOTAL_CHANGED' });
});

test('extension parser caps at500 while destructive start retains cap100', () => {
  const parsed = parseGemmaExtensionArguments(['--extend', '--maintenance-id', id, '--expected-total', '20', '--from', '1970-01-01', '--to', '2026-11-06', '--limit', '500']);
  assert.deepEqual(parsed.selection, larger);
  assert.throws(() => parseGemmaExtensionArguments(['--extend', '--maintenance-id', id, '--expected-total', '20', '--from', '1970-01-01', '--to', '2026-11-06', '--limit', '501']));
  assert.throws(() => parseGemmaRenewalArguments(['--start', '--expected-evaluations', '20', '--expected-policy-version', '6',
    '--expected-configuration-hash', 'a'.repeat(64), '--expected-catalog-hash', 'b'.repeat(64), '--expected-prompt-hash', 'c'.repeat(64),
    '--from', '1970-01-01', '--to', '2026-11-06', '--limit', '500']));
});
