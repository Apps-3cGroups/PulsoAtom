import { pathToFileURL } from 'node:url';
import { summarizeModelResponse } from '../src/services/modelResponseShape.js';

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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Invalid arguments');
    await import('../src/config.js');
    console.log(JSON.stringify(await inspectClefResponse(), null, 2));
  } catch { console.error(JSON.stringify({ operation: 'inspect-existing-clef-response', inferenceCount: 0, error: 'AUDIT_UNAVAILABLE' })); process.exitCode = 1; }
}
