import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../src/errors.js';
import { GatewayApiClient } from '../src/services/gatewayApiClient.js';

const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const malformed = () => new AppError(502, 'El Gateway no devolvió un catálogo reconocible. Confirma el formato con DevOps.', 'INVALID_GATEWAY_CATALOG');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const declaredFailure = value => object(value) && (value.ok === false || value.success === false || !!value.error);

export function parseDiscoveryArgs(args) {
  if (!args.length) return {};
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length === 2 && args[0] === '--tool' && keyPattern.test(args[1])) return { toolKey: args[1] };
  throw new AppError(422, 'Uso: node scripts/discover-local-models.js [--tool CLAVE_EXACTA]', 'INVALID_ARGUMENTS');
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
    return { key: item.key, status: item.status };
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

export async function discoverLocalModels({ toolKey, env = process.env, fetchImpl = fetch } = {}) {
  if (toolKey !== undefined && (typeof toolKey !== 'string' || !keyPattern.test(toolKey))) throw new AppError(422, 'La clave de herramienta no es válida.', 'INVALID_ARGUMENTS');
  const client = new GatewayApiClient({ baseUrl: env.GATEWAY_BASE_URL, token: env.AGENT_SHARED_TOKEN,
    portalKey: env.GATEWAY_PORTAL_KEY ?? 'portal-pulso', timeoutMs: 15000, fetchImpl });
  if (!client.configured) throw new AppError(503, 'Configura GATEWAY_BASE_URL, AGENT_SHARED_TOKEN y GATEWAY_PORTAL_KEY en api/.env.', 'AI_CONFIGURATION');
  const tools = toolsFromCatalog(await client.listTools());
  let output = { tools };
  if (toolKey !== undefined) {
    if (!tools.some(tool => tool.key === toolKey && tool.status === 'active')) throw new AppError(409, 'La herramienta solicitada no está activa en el catálogo del Gateway.', 'TOOL_UNAVAILABLE');
    const models = await client.invoke({ toolKey, method: 'GET', path: '/v1/models', operation: 'descubrir-modelos' });
    output = { tool: toolKey, models: modelIds(models.response), request_uuid: models.requestId };
  }
  // Only allowlisted identifiers leave this script. Even a malformed provider
  // echoing the shared token in an identifier must not print that credential.
  if (JSON.stringify(output).includes(env.AGENT_SHARED_TOKEN.trim())) throw malformed();
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseDiscoveryArgs(process.argv.slice(2));
    if (args.help) console.log('Uso: node scripts/discover-local-models.js [--tool CLAVE_EXACTA]\nSin argumentos lista herramientas. --tool lista modelos de una herramienta activa. Solo consulta; no ejecuta inferencias ni accede a bases de datos.');
    else {
      // Load the existing api/.env only after validating command arguments.
      await import('../src/config.js');
      console.log(JSON.stringify(await discoverLocalModels(args), null, 2));
    }
  } catch (error) {
    const safe = error instanceof AppError ? { code: error.code, message: error.message }
      : { code: 'DISCOVERY_FAILED', message: 'No se pudo consultar el catálogo de modelos locales.' };
    console.error(JSON.stringify({ error: safe }));
    process.exitCode = 1;
  }
}
