import { readFile } from 'node:fs/promises';
import dotenv from 'dotenv';

// Read-only: use the existing ManagerAgents admin credential in-place on the
// same server. Never copy it to Pulso, publish it, or send it to a redirect.
async function main() {
  const env = dotenv.parse(await readFile('/var/www/nodeapps/ManagerAgents/api/.env'));
  const base = new URL(env.GATEWAY_BASE_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !env.GATEWAY_TOKEN) throw new Error('ADMIN_CONFIGURATION_UNAVAILABLE');
  const request = async path => {
    const r = await fetch(`${base.toString().replace(/\/$/, '')}${path}`, { headers: { 'X-Gateway-Token': env.GATEWAY_TOKEN, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    let body; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  const catalog = await request('/v1/admin/tools');
  const rows = [catalog.body, catalog.body?.tools, catalog.body?.data, catalog.body?.data?.tools].find(Array.isArray) || [];
  const tool = rows.find(t => t.key === 'gemma' || t.tool_key === 'gemma');
  function shape(value, key = '', depth = 0) {
    if (depth > 8) return 'depth-limit';
    if (/secret|token|password|auth|headers|url|host/i.test(key)) return '[omitted]';
    if (Array.isArray(value)) return value.slice(0, 40).map(v => shape(v, key, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,shape(v,k,depth+1)]));
    if (typeof value === 'string') {
      if (/^(?:GET|POST|PUT|PATCH|DELETE|active|gemma)$/.test(value) || /^\/(?:api\/)?v1\/[a-zA-Z0-9_/*{}:-]{1,140}$/.test(value)) return value;
      try { return shape(JSON.parse(value), key, depth + 1); } catch {}
      return `string(${value.length})`;
    }
    return value;
  }
  const api = await request('/openapi.json');
  const paths = Object.fromEntries(Object.entries(api.body?.paths || {}).filter(([p]) => /^\/v1\/admin\/tools(?:\/|$)/.test(p)));
  const schemas = api.body?.components?.schemas || {};
  const selected = {};
  function refs(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/components/schemas/')) {
      const name = value.$ref.split('/').at(-1);
      if (!Object.hasOwn(selected, name)) { selected[name] = schemas[name]; refs(schemas[name]); }
    }
    for (const v of Object.values(value)) refs(v);
  }
  refs(paths);
  // OpenAPI contains schema only; omit examples/defaults to avoid deployment data.
  const specification = JSON.parse(JSON.stringify({ paths, schemas: selected }, (k,v) => /example|default|description/i.test(k) ? undefined : v));
  console.log(JSON.stringify({ operation: 'inspect-gateway-administration', writes: 0, inferenceCount: 0, catalogStatus: catalog.status, tool: shape(tool), openapiStatus: api.status, specification }, null, 2));
}
main().catch(() => { console.error(JSON.stringify({ operation: 'inspect-gateway-administration', error: 'ADMIN_INSPECTION_UNAVAILABLE', writes: 0 })); process.exitCode = 1; });
