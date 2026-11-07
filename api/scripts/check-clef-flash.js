import { pathToFileURL } from 'node:url';
import { AppError } from '../src/errors.js';
import { discoverGatewayTools, discoverGatewayModels } from '../src/services/gatewayDiscovery.js';
import { runSmallClefChecks } from './check-clef-small.js';

const allowedTools = ['gemma', 'qwen', 'clef'];
const errorCodes = new Set(['AI_CONFIGURATION', 'AI_UNAVAILABLE', 'AI_TRANSIENT', 'INVALID_AI_RESULT', 'INVALID_GATEWAY_CATALOG', 'TOOL_UNAVAILABLE']);
const safeError = error => ({ code: error instanceof AppError && errorCodes.has(error.code) ? error.code : 'CLEF_FLASH_CHECK_FAILED',
  message: 'No se completó la comprobación de Clef Flash. No se cambió configuración ni se guardaron evaluaciones.' });
function safeIdentifier(value, secrets) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/.test(value)
    && !value.includes('://') && !/(?:\d{1,3}\.){3}\d{1,3}/.test(value)
    && !secrets.some(secret => value.toLowerCase().includes(secret.toLowerCase()));
}

export async function runClefFlashCheck({ env = process.env, fetchImpl = fetch } = {}) {
  const secrets = Object.entries(env).filter(([key, value]) => /secret|token|password|key|url|host/i.test(key) && !/(?:TOOL|PORTAL)_KEY$/i.test(key)
    && typeof value === 'string' && value.length >= 4).map(([, value]) => value);
  try { secrets.push(new URL(env.GATEWAY_BASE_URL).hostname); } catch {}
  const report = { success: false, synthetic: true, tools: [], catalogs: [], target: null, result: null };
  let tools;
  try {
    ({ tools } = await discoverGatewayTools({ env, fetchImpl }));
    report.tools = tools.filter(tool => allowedTools.includes(tool.key));
  } catch (error) { return { ...report, error: safeError(error) }; }
  for (const toolKey of allowedTools.filter(key => tools.some(tool => tool.key === key && tool.status === 'active'))) {
    try {
      const catalog = await discoverGatewayModels({ toolKey, env, fetchImpl, tools });
      if (catalog.models.some(model => !safeIdentifier(model, secrets)) || !safeIdentifier(catalog.request_uuid, secrets)) {
        throw new AppError(502, 'Catálogo inválido.', 'INVALID_GATEWAY_CATALOG');
      }
      report.catalogs.push({ toolKey, models: catalog.models, request_uuid: catalog.request_uuid });
    } catch (error) { report.catalogs.push({ toolKey, models: [], error: safeError(error) }); }
  }
  const candidates = report.catalogs.flatMap(catalog => catalog.models
    .filter(model => /^clef[-_]flash$/i.test(model.split('/').at(-1)))
    .map(model => ({ toolKey: catalog.toolKey, model })));
  const preferred = candidates.filter(candidate => candidate.toolKey === 'gemma');
  const selected = preferred.length ? preferred : candidates;
  if (selected.length !== 1 || (!preferred.length && report.catalogs.some(catalog => catalog.error))) {
    return { ...report, error: { code: selected.length > 1 ? 'CLEF_FLASH_AMBIGUOUS'
      : report.catalogs.some(catalog => catalog.error) ? 'CLEF_FLASH_DISCOVERY_INCOMPLETE' : 'CLEF_FLASH_NOT_FOUND',
    message: 'No hay un único destino Clef Flash verificable. No se ejecutó inferencia.' } };
  }
  report.target = selected[0];
  try {
    report.result = await runSmallClefChecks({ env, fetchImpl, minimalOnly: true, model: report.target.model, toolKey: report.target.toolKey });
    report.success = report.result.success === true && report.result.model === report.target.model
      && report.result.toolKey === report.target.toolKey && report.result.stages?.length === 1;
  } catch (error) { report.error = safeError(error); }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Unsupported arguments');
    await import('../src/config.js');
    const result = await runClefFlashCheck();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.success ? 0 : 1;
  } catch {
    console.error('No se pudo completar la comprobación de Clef Flash. No se modificó ningún dato.');
    process.exitCode = 2;
  }
}
