import { AppError } from '../errors.js';
import { GatewayApiClient } from './gatewayApiClient.js';

export const gatewayToolKeyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
export const gatewayModelIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/;
const keyPattern = gatewayToolKeyPattern;
const malformed = () => new AppError(502, 'El Gateway no devolvió un catálogo reconocible. Confirma el formato con DevOps.', 'INVALID_GATEWAY_CATALOG');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const declaredFailure = value => object(value) && (value.ok === false || value.success === false || !!value.error);
const gatewayClient = (env, fetchImpl = fetch) => new GatewayApiClient({ baseUrl: env.GATEWAY_BASE_URL, token: env.AGENT_SHARED_TOKEN,
  portalKey: env.GATEWAY_PORTAL_KEY ?? 'portal-pulso', timeoutMs: 15000, fetchImpl });
export const gatewayConfigured = (env = process.env) => gatewayClient(env).configured;
const configuredClient = (env, fetchImpl) => {
  const client = gatewayClient(env, fetchImpl);
  if (!client.configured) throw new AppError(503, 'Configura la conexión al Gateway en el servidor de Pulso.', 'AI_CONFIGURATION');
  return client;
};
function safeOutput(output, env) {
  const token = typeof env.AGENT_SHARED_TOKEN === 'string' ? env.AGENT_SHARED_TOKEN.trim() : '';
  if (token && JSON.stringify(output).includes(token)) throw malformed();
  return output;
}

function catalogItems(raw, collection) {
  if (declaredFailure(raw) || declaredFailure(raw?.data)) throw malformed();
  const candidates = [Array.isArray(raw) ? raw : null,
    Array.isArray(raw?.[collection]) ? raw[collection] : null,
    Array.isArray(raw?.data) ? raw.data : null,
    Array.isArray(raw?.data?.[collection]) ? raw.data[collection] : null].filter(Boolean);
  // Ambiguous envelopes are not resolved by guessing one of their collections.
  if (candidates.length !== 1) throw malformed();
  return candidates[0];
}

function toolsFromCatalog(raw) {
  const tools = catalogItems(raw, 'tools').map(item => {
    if (!object(item) || typeof item.key !== 'string' || !keyPattern.test(item.key)
      || typeof item.status !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(item.status)) throw malformed();
    // Only expose supported protocol names, never provider URLs or the raw
    // allowlist. Older catalogs without capability fields remain readable.
    let protocols;
    if (Object.hasOwn(item, 'paths')) {
      if (!Array.isArray(item.paths) || item.paths.some(route => !object(route)
        || typeof route.method !== 'string' || typeof route.path !== 'string')) throw malformed();
      const has = (method, path) => item.paths.some(route => route.method === method && route.path === path);
      protocols = [];
      if (has('POST', '/v1/chat/completions')) protocols.push('chat');
      if (has('POST', '/v1/systemone') && has('GET', '/api/v1/models')) protocols.push('systemone');
    }
    return { key: item.key, status: item.status, ...(protocols ? { protocols } : {}) };
  });
  if (new Set(tools.map(t => t.key)).size !== tools.length) throw malformed();
  return tools;
}

function modelIds(raw) {
  const ids = catalogItems(raw, 'models').map(item => {
    if (!object(item) || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/.test(item.id)
      || item.id.includes('://')) throw malformed();
    return item.id;
  });
  if (new Set(ids).size !== ids.length) throw malformed();
  return ids;
}


export async function discoverGatewayTools({ env = process.env, fetchImpl = fetch } = {}) {
  const client = configuredClient(env, fetchImpl);
  return safeOutput({ tools: toolsFromCatalog(await client.listTools()) }, env);
}

export async function discoverGatewayModels({ toolKey, env = process.env, fetchImpl = fetch, tools } = {}) {
  if (typeof toolKey !== 'string' || !keyPattern.test(toolKey)) throw new AppError(422, 'La clave de herramienta no es válida.', 'INVALID_ARGUMENTS');
  const client = configuredClient(env, fetchImpl);
  const available = tools === undefined ? (await discoverGatewayTools({ env, fetchImpl })).tools : toolsFromCatalog(tools);
  if (!available.some(tool => tool.key === toolKey && tool.status === 'active')) throw new AppError(409, 'La herramienta solicitada no está activa en el catálogo del Gateway.', 'TOOL_UNAVAILABLE');
  const models = await client.invoke({ toolKey, method: 'GET', path: '/v1/models', operation: 'descubrir-modelos' });
  return safeOutput({ tool: toolKey, models: modelIds(models.response), request_uuid: models.requestId }, env);
}

export async function discoverLocalModels({ toolKey, env = process.env, fetchImpl = fetch } = {}) {
  return toolKey === undefined ? discoverGatewayTools({ env, fetchImpl }) : discoverGatewayModels({ toolKey, env, fetchImpl });
}
