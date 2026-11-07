import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { summarizeModelResponse } from '../src/services/modelResponseShape.js';
import { safeGatewayErrorDetails } from '../src/services/safeGatewayError.js';
import { GatewayApiClient } from '../src/services/gatewayApiClient.js';

const target = 'c8c48c73-e56e-463f-845a-fb27240af4e3';
// Read an existing execution only. This admin route is documented by the
// ManagerAgents client; never guess alternative routes or invoke a model.
export async function inspectClefResponse({ env = process.env, fetchImpl = fetch } = {}) {
  const url = new URL(env.GATEWAY_BASE_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Gateway');
  if (!env.AGENT_SHARED_TOKEN) throw new Error('Missing Gateway token');
  const response = await fetchImpl(`${url.toString().replace(/\/$/, '')}/v1/admin/tools/gemma/runs?limit=200`, {
    redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json', 'X-Gateway-Token': env.AGENT_SHARED_TOKEN },
  });
  const report = { operation: 'inspect-existing-clef-response', inferenceCount: 0, requestUuid: target, httpStatus: response.status, found: false };
  if (!response.ok) return report;
  const data = await response.json();
  const candidates = Array.isArray(data) ? data : [data?.runs, data?.data, data?.items, data?.records, data?.results].find(Array.isArray) || [];
  report.recordsInspected = candidates.length;
  const record = candidates.find(item => item?.request_uuid === target || item?.requestUuid === target);
  if (!record) return report;
  report.found = true;
  report.availableFields = ['response', 'response_json', 'response_body', 'output', 'result', 'upstream_status_code', 'latency_ms', 'status', 'error'].filter(key => Object.hasOwn(record, key));
  const shapes = [];
  function inspect(value, depth = 0) {
    if (depth > 5 || value == null) return;
    if (typeof value === 'string') {
      if (value.length > 2_000_000) return;
      try { inspect(JSON.parse(value), depth + 1); } catch {}
      return;
    }
    if (typeof value !== 'object' || Array.isArray(value)) return;
    if (Array.isArray(value.choices)) { shapes.push(summarizeModelResponse(value)); return; }
    for (const key of ['response', 'response_json', 'response_body', 'output', 'result', 'data']) inspect(value[key], depth + 1);
  }
  inspect(record);
  return { ...report, responseAvailable: shapes.length > 0, shapes };
}

export async function inspectClefCapabilities({ env = process.env, fetchImpl = fetch } = {}) {
  const client = new GatewayApiClient({ baseUrl: env.GATEWAY_BASE_URL, token: env.AGENT_SHARED_TOKEN,
    portalKey: 'portal-pulso', timeoutMs: 15000, fetchImpl });
  const catalog = await client.listTools();
  const rows = [catalog, catalog?.tools, catalog?.data, catalog?.data?.tools].find(Array.isArray) || [];
  const tool = rows.find(row => row.key === 'gemma' && row.status === 'active');
  if (!tool) throw new Error('Tool unavailable');
  const paths = new Set(), methods = new Set();
  function scan(value, depth = 0) {
    if (depth > 6) return;
    if (typeof value === 'string') {
      if (/^\/(?:api\/)?v1\/[a-zA-Z0-9_/*{}:-]{1,140}$/.test(value)) paths.add(value);
      else if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(value)) methods.add(value);
      else { try { scan(JSON.parse(value), depth + 1); } catch {} }
    } else if (Array.isArray(value)) value.forEach(item => scan(item, depth + 1));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (/path|route|method|allow/i.test(key)) scan(item, depth + 1);
    }
  }
  scan(tool);
  const response = await client.invoke({ toolKey: 'gemma', method: 'GET', path: '/v1/models', operation: 'clef-capabilities' });
  const models = [response.response, response.response?.data, response.response?.models, response.response?.data?.models].find(Array.isArray) || [];
  const match = models.find(item => item.id === 'clef-flash');
  const metadata = {};
  if (match) for (const field of ['type', 'object', 'architecture', 'state', 'loaded', 'max_context_length', 'context_length']) {
    const value = match[field];
    if (typeof value === 'boolean' || typeof value === 'number' && Number.isSafeInteger(value)
      || typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)) metadata[field] = value;
  }
  return { operation: 'inspect-clef-capabilities', inferenceCount: 0, tool: 'gemma', model: 'clef-flash',
    modelListed: !!match, methods: [...methods], paths: [...paths], metadata };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const saved = process.argv.length === 3 && process.argv[2] === '--saved';
    const capabilities = process.argv.length === 3 && process.argv[2] === '--capabilities';
    if (process.argv.length !== 2 && !saved && !capabilities) throw new Error('Invalid arguments');
    await import('../src/config.js');
    if (saved) {
      const artifact = JSON.parse(await readFile('/var/www/nodeapps/PulsoAtom/api/.data/diagnostics/clef-flash-6135-prompt-json-v1.json', 'utf8'));
      if (artifact.conversationId !== '6135' || artifact.requestMode !== 'prompt-json' || artifact.model !== 'clef-flash') throw new Error('Wrong artifact');
      const errors = ['gateway', 'upstream'].flatMap(layer => (artifact.protocol?.errorDetails?.[layer] || []).slice(0, 2)
        .map(message => ({ layer, ...safeGatewayErrorDetails({ error: message }, process.env) })));
      console.log(JSON.stringify({ operation: 'inspect-saved-clef-response', inferenceCount: 0,
        errorCode: artifact.errorCode, errors }, null, 2));
    } else console.log(JSON.stringify(await (capabilities ? inspectClefCapabilities() : inspectClefResponse()), null, 2));
  } catch { console.error(JSON.stringify({ operation: 'inspect-existing-clef-response', inferenceCount: 0, error: 'AUDIT_UNAVAILABLE' })); process.exitCode = 1; }
}
