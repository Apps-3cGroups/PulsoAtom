import { pathToFileURL } from 'node:url';
import { AppError } from '../src/errors.js';
import { GatewayEvaluator } from '../src/gateway-evaluator.js';
import { discoverGatewayTools, discoverGatewayModels } from '../src/services/gatewayDiscovery.js';
import { gemmaContractConversation } from '../src/gemma-contract-check.js';

const toolKeys = ['clef', 'qwen', 'gemma'];
const variables = [
  { id: 'cliente_felicito_al_asistente', type: 'Flag', method: 'IA', active: true,
    name: 'Cliente felicitó al asistente', definition: '1 si el cliente felicitó explícitamente al asistente. Un agradecimiento intenso no se considera felicitación.' },
  { id: 'asistente_comunicacion_poco_profesional', type: 'Flag', method: 'IA', active: true,
    name: 'Comunicación poco profesional', definition: '1 si el asistente utilizó comunicación poco profesional, expresiones irrespetuosas o incumplió la guía de emojis; 0 si no aparece esa conducta.' },
];
const codes = new Set(['AI_CONFIGURATION', 'AI_UNAVAILABLE', 'AI_TRANSIENT', 'INVALID_AI_RESULT', 'INVALID_GATEWAY_CATALOG',
  'TOOL_UNAVAILABLE', 'MODEL_CHANGED', 'MODEL_IDENTITY_UNVERIFIED', 'AI_SAFETY_REFUSAL', 'AI_INCOMPLETE']);
const safeError = error => ({ code: error instanceof AppError && codes.has(error.code) ? error.code : 'CLEF_CHECK_FAILED',
  message: 'No se completó esta comprobación. No se cambió configuración ni se guardaron evaluaciones.' });
const safeId = (value, secrets) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/.test(value)
  && !value.includes('://') && !secrets.some(secret => secret && value.includes(secret)) ? value : null;

async function readServerConfiguration({ env }) {
  if (!env.APP_DB_HOST || !env.APP_DB_USER || !env.APP_DB_NAME) return null;
  const { default: mysql } = await import('mysql2/promise');
  const connection = await mysql.createConnection({ host: env.APP_DB_HOST, port: Number(env.APP_DB_PORT || 3306),
    user: env.APP_DB_USER, password: env.APP_DB_PASSWORD || '', database: env.APP_DB_NAME,
    connectTimeout: 3000, charset: 'utf8mb4', timezone: 'Z',
    ...(env.APP_DB_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}) });
  try {
    const [rows] = await connection.query({ sql: 'SELECT payload FROM portal_settings WHERE id = ?', timeout: 3000 }, ['settings']);
    if (rows.length !== 1) return null;
    return typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
  } finally { connection.destroy(); }
}

// One synthetic inference at most. This function never reads Atom or calls a
// model through Pulso's evaluation service, so it cannot persist an evaluation.
export async function main({ args = [], env = process.env, fetchImpl = fetch, readConfiguration = readServerConfiguration } = {}) {
  if (args.length === 1 && args[0] === '--help') return { help: true, message: 'Uso: node scripts/check-clef-availability.js [--mounted-clef]\nDescubre herramientas/modelos, lee solo configuración y realiza como máximo una prueba sintética de Clef. No cambia política, catálogo ni evaluaciones.' };
  const mountedClef = args.length === 1 && args[0] === '--mounted-clef';
  if (args.length && !mountedClef) throw new AppError(422, 'Usa --help o --mounted-clef.', 'INVALID_ARGUMENTS');
  let host = '';
  try { host = new URL(env.GATEWAY_BASE_URL).hostname; } catch {}
  const secrets = [env.AGENT_SHARED_TOKEN, env.GATEWAY_BASE_URL, host].filter(Boolean);
  const report = { success: false, synthetic: true, checkedAt: new Date().toISOString(), tools: [], catalogs: [],
    configurationRead: 'not_attempted', configuredClef: null, policy: null, candidate: null, inferenceCount: 0, probe: null };
  let available;
  try {
    available = await discoverGatewayTools({ env, fetchImpl });
    report.tools = available.tools.filter(tool => toolKeys.includes(tool.key));
  } catch (error) { return { ...report, error: safeError(error) }; }
  for (const toolKey of toolKeys.filter(key => available.tools.some(tool => tool.key === key && tool.status === 'active'))) {
    try {
      const catalog = await discoverGatewayModels({ toolKey, env, fetchImpl, tools: available.tools });
      if (catalog.models.some(model => !safeId(model, secrets))) throw new AppError(502, 'Catálogo inválido.', 'INVALID_GATEWAY_CATALOG');
      report.catalogs.push({ toolKey, models: catalog.models, request_uuid: safeId(catalog.request_uuid, secrets) });
    } catch (error) { report.catalogs.push({ toolKey, models: [], error: safeError(error) }); }
  }
  let settings;
  try {
    settings = await readConfiguration({ env });
    report.configurationRead = settings ? 'read' : 'unavailable';
  } catch { report.configurationRead = 'unavailable'; }
  const saved = settings?.localModelConfiguration?.profiles?.find(profile => profile.id === 'clef-local');
  const configured = saved || { toolKey: env.CLEF_TOOL_KEY, model: env.CLEF_MODEL, enabled: env.CLEF_EVALUATION_ENABLED === 'true', responseFormat: env.CLEF_RESPONSE_FORMAT || 'json_schema' };
  report.configuredClef = { source: saved ? 'persisted' : 'environment', id: 'clef-local',
    toolKey: safeId(configured.toolKey, secrets), model: safeId(configured.model, secrets), enabled: configured.enabled === true,
    responseFormat: ['json_schema', 'json_object'].includes(configured.responseFormat) ? configured.responseFormat : null };
  if (settings?.aiPolicy) report.policy = { version: Number.isSafeInteger(settings.aiPolicy.version) ? settings.aiPolicy.version : null,
    mode: ['single', 'dual'].includes(settings.aiPolicy.mode) ? settings.aiPolicy.mode : null,
    primaryId: safeId(settings.aiPolicy.primaryId, secrets), secondaryId: safeId(settings.aiPolicy.secondaryId, secrets),
    fallbackId: safeId(settings.aiPolicy.fallbackId, secrets), dailyEnabled: settings.dailyEnabled === true };
  const matches = report.catalogs.flatMap(catalog => catalog.models.filter(model => /clef/i.test(model)).map(model => ({ toolKey: catalog.toolKey, model })));
  const preferred = matches.filter(candidate => candidate.toolKey !== 'gemma');
  // The newly mounted model was confirmed in the Gateway catalog. This explicit
  // probe never substitutes the saved clef-flash profile or persists a change.
  const candidates = mountedClef
    ? matches.filter(candidate => candidate.toolKey === 'gemma' && candidate.model === 'cloudflare_clef')
    : preferred.length ? preferred : matches;
  const ids = [...new Set(candidates.map(candidate => candidate.model))];
  if (ids.length !== 1) return { ...report, error: { code: ids.length ? 'CLEF_MODEL_AMBIGUOUS' : 'CLEF_MODEL_NOT_FOUND',
    message: ids.length ? 'Hay varios identificadores Clef. Confirma el modelo exacto antes de probar.' : 'Ninguna herramienta consultada publica un modelo Clef inequívoco.' } };
  const candidate = candidates.find(item => item.model === ids[0]);
  const responseFormat = report.configuredClef.responseFormat || 'json_schema';
  report.candidate = { ...candidate, responseFormat,
    matchesConfiguredProfile: candidate.toolKey === configured.toolKey && candidate.model === configured.model };
  let transport = null;
  // Inspect only protocol metadata on a cloned response. Never retain provider
  // messages, generated content, credentials or private URLs in the diagnostic.
  const tracedFetch = async (...args) => {
    const response = await fetchImpl(...args);
    transport = { gatewayStatus: Number.isInteger(response.status) ? response.status : null,
      upstreamStatus: null, request_uuid: null, actualModel: null };
    try {
      const envelope = await response.clone().json();
      transport.upstreamStatus = Number.isInteger(envelope?.upstream_status_code) && envelope.upstream_status_code >= 100 && envelope.upstream_status_code <= 599 ? envelope.upstream_status_code : null;
      transport.request_uuid = safeId(envelope?.request_uuid, secrets);
      transport.actualModel = safeId(envelope?.response?.model, secrets);
    } catch {}
    return response;
  };
  const evaluator = new GatewayEvaluator({ baseUrl: env.GATEWAY_BASE_URL, token: env.AGENT_SHARED_TOKEN,
    portalKey: env.GATEWAY_PORTAL_KEY ?? 'portal-pulso', toolKey: candidate.toolKey, model: candidate.model,
    timeoutMs: 180000, maxTokens: 2048, temperature: 0, responseFormat, fetchImpl: tracedFetch });
  if (!evaluator.configured) return { ...report, error: { code: 'AI_CONFIGURATION', message: 'La configuración no admite la prueba sintética.' } };
  const started = Date.now(); report.inferenceCount = 1;
  try {
    const response = await evaluator.evaluate(structuredClone(gemmaContractConversation), structuredClone(variables));
    const present = response.results.find(item => item.variableId === variables[0].id);
    const absent = response.results.find(item => item.variableId === variables[1].id);
    const semanticChecks = {
      explicitCongratulations: present?.status === 'evaluado' && present.value === 1 && present.evidence?.some(e => e.messageId === 'synthetic-client-2') === true,
      professionalCommunication: absent?.status === 'evaluado' && absent.value === 0 && absent.evidence?.length === 0,
    };
    const allowedRules = new Set(['missing_item', 'invalid_status', 'invalid_value_type', 'invalid_reason', 'invalid_evidence_count',
      'unknown_evidence_message', 'missing_evidence', 'unexpected_evidence', 'inconsistent_status_value']);
    const errors = (response.validationErrors || []).filter(error => variables.some(v => v.id === error.variableId))
      .map(error => ({ variableId: error.variableId, rules: (error.rules || []).filter(rule => allowedRules.has(rule)) }));
    report.probe = { model: safeId(response.model, secrets), request_uuid: safeId(response.responseId, secrets), transport, durationMs: Date.now() - started,
      valid: response.results.length, expected: 2, semanticChecks, validationErrors: errors };
    report.success = response.model === candidate.model && response.results.length === 2 && errors.length === 0 && Object.values(semanticChecks).every(value => value === true);
  } catch (error) { report.probe = { durationMs: Date.now() - started, transport, error: safeError(error) }; }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--mounted-clef')) await import('../src/config.js');
    const result = await main({ args: process.argv.slice(2) });
    console.log(result.help ? result.message : JSON.stringify(result, null, 2));
    process.exitCode = result.help || result.success ? 0 : 1;
  } catch {
    console.error('No se pudo completar el diagnóstico de Clef. No se modificó la configuración ni se guardaron evaluaciones.');
    process.exitCode = 2;
  }
}
