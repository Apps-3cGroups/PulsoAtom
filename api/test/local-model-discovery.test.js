import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { discoverLocalModels, parseDiscoveryArgs } from '../scripts/discover-local-models.js';

const env = { GATEWAY_BASE_URL: 'http://synthetic-gateway.test:9000', AGENT_SHARED_TOKEN: 'synthetic-token-not-public', GATEWAY_PORTAL_KEY: 'portal-pulso' };
const tools = [{ key: 'clef', status: 'active', base_url: 'http://private-provider.test:1234', credentials: env.AGENT_SHARED_TOKEN }, { key: 'gemma', status: 'inactive' }];
const response = body => ({ ok: true, status: 200, async json() { return body; } });

test('discovery accepts only a bare command, help or one exact tool key', () => {
  assert.deepEqual(parseDiscoveryArgs([]), {});
  assert.deepEqual(parseDiscoveryArgs(['--help']), { help: true });
  assert.deepEqual(parseDiscoveryArgs(['--tool', 'clef']), { toolKey: 'clef' });
  for (const args of [['--tool'], ['--tool', '../gemma'], ['--tool', 'gemma', '--tool', 'clef'], ['--token', 'secret'], ['--help', '--tool', 'gemma']]) {
    assert.throws(() => parseDiscoveryArgs(args), { code: 'INVALID_ARGUMENTS' });
  }
});

test('tools are allowlisted from array, tools, data and data.tools envelopes', async () => {
  for (const catalog of [tools, { tools }, { data: tools }, { data: { tools } }]) {
    const calls = [];
    const result = await discoverLocalModels({ env, fetchImpl: async (...args) => { calls.push(args); return response(catalog); } });
    assert.deepEqual(result, { tools: [{ key: 'clef', status: 'active' }, { key: 'gemma', status: 'inactive' }] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], env.GATEWAY_BASE_URL + '/v1/tools');
    assert.equal(calls[0][1].method, 'GET');
    assert.ok(!JSON.stringify(result).includes('private-provider'));
    assert.ok(!JSON.stringify(result).includes(env.AGENT_SHARED_TOKEN));
  }
});

test('an explicitly active tool lists exact model IDs with Gateway request UUID and no inference', async () => {
  const calls = [];
  const result = await discoverLocalModels({ env, toolKey: 'clef', fetchImpl: async (url, options) => {
    calls.push([url, options]);
    return response(url.endsWith('/v1/tools') ? { tools } : { ok: true, tool_key: 'clef', request_uuid: 'synthetic-discovery-uuid',
      method: 'GET', path: '/v1/models', upstream_status_code: 200,
      response: { data: [{ id: 'local-org/clef:quantized', path: '/private/model/file' }], token: env.AGENT_SHARED_TOKEN } });
  } });
  assert.deepEqual(result, { tool: 'clef', models: ['local-org/clef:quantized'], request_uuid: 'synthetic-discovery-uuid' });
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[1][1].body);
  assert.equal(body.method, 'GET');
  assert.equal(body.path, '/v1/models');
  assert.equal(body.body, null);
  assert.equal(body.portal_key, 'portal-pulso');
  assert.equal(body.caller.operation, 'descubrir-modelos');
  assert.ok(!JSON.stringify(calls).includes('/chat/completions'));
});

test('unknown or inactive tools and malformed catalogs fail before model discovery', async () => {
  for (const toolKey of ['unknown', 'gemma']) {
    let calls = 0;
    await assert.rejects(discoverLocalModels({ env, toolKey, fetchImpl: async () => { calls++; return response({ tools }); } }), { code: 'TOOL_UNAVAILABLE' });
    assert.equal(calls, 1);
  }
  for (const catalog of [{ error: 'private error with token', tools }, { ok: false, tools }, { tools, data: tools }, { items: tools },
    [{ key: 'clef', status: 'active' }, { key: 'clef', status: 'active' }], [{ key: 'clef', status: 'http://private-url' }]]) {
    await assert.rejects(discoverLocalModels({ env, fetchImpl: async () => response(catalog) }), error => {
      assert.equal(error.code, 'INVALID_GATEWAY_CATALOG');
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
});

test('missing configuration and invalid arguments do not call any service', async () => {
  const fetchImpl = () => assert.fail('No requests expected');
  await assert.rejects(discoverLocalModels({ env: {}, fetchImpl }), { code: 'AI_CONFIGURATION' });
  await assert.rejects(discoverLocalModels({ env, toolKey: '../other', fetchImpl }), { code: 'INVALID_ARGUMENTS' });
});

test('missing portal key uses the confirmed Pulso identity but an explicitly blank value is invalid', async () => {
  const withoutPortalKey = { ...env };
  delete withoutPortalKey.GATEWAY_PORTAL_KEY;
  let invocation;
  await discoverLocalModels({ env: withoutPortalKey, toolKey: 'clef', fetchImpl: async (url, options) => {
    if (url.endsWith('/v1/tools')) return response({ tools });
    invocation = JSON.parse(options.body);
    return response({ ok: true, tool_key: 'clef', request_uuid: 'synthetic-default-portal', method: 'GET', path: '/v1/models',
      upstream_status_code: 200, response: { data: [{ id: 'synthetic-clef' }] } });
  } });
  assert.equal(invocation.portal_key, 'portal-pulso');
  assert.equal(invocation.caller.source, 'portal-pulso');
  await assert.rejects(discoverLocalModels({ env: { ...env, GATEWAY_PORTAL_KEY: '' },
    fetchImpl: () => assert.fail('Explicit blank portal key must fail before network access') }), { code: 'AI_CONFIGURATION' });
});

test('provider echoes cannot print the shared token or private URLs as model IDs', async () => {
  for (const id of [env.AGENT_SHARED_TOKEN, 'http://private-provider.test/model']) {
    const fetchImpl = async url => response(url.endsWith('/v1/tools') ? { tools } : { ok: true, tool_key: 'clef', request_uuid: 'synthetic-id',
      method: 'GET', path: '/v1/models', upstream_status_code: 200, response: { data: [{ id }] } });
    await assert.rejects(discoverLocalModels({ env, toolKey: 'clef', fetchImpl }), error => {
      assert.equal(error.code, 'INVALID_GATEWAY_CATALOG');
      assert.ok(!JSON.stringify(error).includes(id));
      return true;
    });
  }
});

test('CLI validates arguments before dotenv loading and prints sanitized errors', () => {
  const script = new URL('../scripts/discover-local-models.js', import.meta.url);
  const help = spawnSync(process.execPath, [script.pathname, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Solo consulta/);
  const invalid = spawnSync(process.execPath, [script.pathname, '--unexpected', env.AGENT_SHARED_TOKEN], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_ARGUMENTS');
  assert.ok(!invalid.stderr.includes(env.AGENT_SHARED_TOKEN));
});
