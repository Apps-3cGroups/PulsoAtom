import '../src/config.js';
import { safeGatewayErrorDetails } from '../src/services/safeGatewayError.js';

// One bounded synthetic contract probe of the exact loaded ID, even when the
// inventory says llm, to identify the runtime rejection. This is diagnostic,
// never a bypass of the production evaluator's decision identity guard.
const env = process.env;
const MODEL = 'cloudflare_clef';
async function main() {
  const base = new URL(env.GATEWAY_BASE_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !env.AGENT_SHARED_TOKEN) throw new Error('Configuration');
  const call = async (path, body) => {
    const response = await fetch(`${base.toString().replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { 'X-Gateway-Token': env.AGENT_SHARED_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let data; try { data = await response.json(); } catch {}
    return { status: response.status, data };
  };
  const catalog = await call('/v1/tools');
  const rows = [catalog.data, catalog.data?.tools, catalog.data?.data].find(Array.isArray) || [];
  const tool = rows.find(t => t.key === 'gemma');
  const routes = (tool?.paths || []).map(p => `${p.method} ${p.path}`);
  const report = { operation: 'native-clef-synthetic-probe', inferenceCount: 0, catalogStatus: catalog.status,
    requestedModel: MODEL, routesReady: ['POST /v1/systemone', 'GET /api/v1/models'].every(p => routes.includes(p)) };
  if (!report.routesReady) { console.log(JSON.stringify(report)); return; }
  const invoke = (method, path, body = null) => call('/v1/tools/gemma/invoke', { method, path, body, query: {}, timeout_ms: 40000,
    portal_key: 'portal-pulso', caller: { source: 'portal-pulso', mode: 'portal', operation: 'native-clef-synthetic-probe' } });
  const inventory = await invoke('GET', '/api/v1/models');
  report.inventoryStatus = inventory.data?.upstream_status_code ?? inventory.status;
  const models = inventory.data?.response?.models;
  if (!Array.isArray(models)) { console.log(JSON.stringify(report)); return; }
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9._:/@-]{1,200}$/.test(value) && !value.includes('://') ? value : null;
  report.models = models.slice(0, 30).map(m => ({ key: id(m.key), type: id(m.type),
    instances: (m.loaded_instances || []).map(i => ({ id: id(i.id), contextLength: Number.isSafeInteger(i.config?.context_length) ? i.config.context_length : null })) }));
  const candidate = models.find(m => m.type === 'decision' && m.loaded_instances?.some(i => i.id === MODEL));
  report.clefDecisionLoaded = !!candidate;
  if (!models.some(m => m.key === MODEL && m.type === 'decision')) { console.log(JSON.stringify(report, null, 2)); return; }
  const probe = await invoke('POST', '/v1/systemone', { model: MODEL, state: 'ENSAYO SINTETICO: el cliente escribió PRUEBA_POSITIVA_LOCAL.', questions: {
    marker: { type: 'choice', instructions: 'Selecciona present si el texto contiene literalmente PRUEBA_POSITIVA_LOCAL; absent si no aparece.', criteria: { present: 'El texto contiene el marcador.', absent: 'El texto no contiene el marcador.' } },
  } });
  report.inferenceCount = 1;
  report.probeStatus = probe.data?.upstream_status_code ?? probe.status;
  report.requestId = id(probe.data?.request_uuid);
  const result = probe.data?.response;
  report.responseModel = id(result?.model);
  report.answer = result?.answers?.marker?.choice === 'present' || result?.answers?.marker?.choice === 'absent' ? result.answers.marker.choice : null;
  report.valid = report.probeStatus === 200 && report.responseModel === MODEL && report.answer === 'present';
  if (!report.valid) report.errorDetails = safeGatewayErrorDetails(result || probe.data, env);
  console.log(JSON.stringify(report, null, 2));
}
main().catch(() => { console.error(JSON.stringify({ operation: 'native-clef-synthetic-probe', error: 'NATIVE_PROBE_UNAVAILABLE' })); process.exitCode = 1; });
