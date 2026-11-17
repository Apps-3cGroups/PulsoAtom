// Synthetic diagnostic only: read persisted settings, never Atom or evaluation
// tables. No writes, scheduling, retries, deployment or service restart.
import { pathToFileURL } from 'node:url';
import { AppError } from '../src/errors.js';

const allowedProfiles = new Set(['clef-local', 'gemma-local']);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/.test(value)
  && !value.includes('://') ? value : null;
const codes = new Set(['AI_CONFIGURATION', 'AI_UNAVAILABLE', 'AI_TRANSIENT', 'AI_CONTEXT_LIMIT', 'AI_RESOURCE_LIMIT',
  'INVALID_AI_RESULT', 'AI_INCOMPLETE', 'MODEL_CHANGED', 'MODEL_IDENTITY_UNVERIFIED', 'AI_SAFETY_REFUSAL']);
const conversation = { id: 'pulso-connectivity-synthetic', country: 'HN', completed: true, messages: [
  { id: 'synthetic-client', actor: 'cliente', text: 'PRUEBA_POSITIVA_LOCAL', timestamp: '2026-01-01T12:00:00.000Z' },
  { id: 'synthetic-agent', actor: 'humano', text: 'Recibí la prueba sintética.', timestamp: '2026-01-01T12:00:01.000Z' },
] };
const variables = [{ id: 'local_probe_present', version: 1, type: 'Flag', method: 'IA', active: true,
  name: 'Prueba sintética de conexión', definition: '1 si un mensaje del cliente contiene literalmente PRUEBA_POSITIVA_LOCAL; de lo contrario 0.' }];

export async function checkConnectivity({ connection, registryFactory, profileId, fetchImpl = fetch, emit = console.log }) {
  if (!allowedProfiles.has(profileId)) throw new Error('INVALID_PROFILE');
  let stage = 'settings', inferenceRequests = 0;
  const started = Date.now();
  const events = [];
  const record = event => { events.push(event); emit(JSON.stringify(event)); };
  const observedFetch = async (url, options) => {
    // Observe only fixed HTTP metadata, never URLs, headers, prompts or payloads.
    const request = options.body ? JSON.parse(options.body) : null;
    const inference = request?.method === 'POST';
    if (inference && ++inferenceRequests > 4) throw new Error('DIAGNOSTIC_REQUEST_LIMIT');
    const start = Date.now();
    const response = await fetchImpl(url, options);
    let envelope;
    try { envelope = await response.clone().json(); } catch { envelope = null; }
    record({ stage, gatewayHttpStatus: response.status,
      upstreamStatus: Number.isInteger(envelope?.upstream_status_code) ? envelope.upstream_status_code : null,
      requestId: safeId(envelope?.request_uuid), durationMs: Date.now() - start });
    return response;
  };
  try {
    await connection.query('START TRANSACTION READ ONLY');
    let settings;
    try {
      const [rows] = await connection.query("SELECT payload FROM portal_settings WHERE id = 'settings'");
      if (rows.length !== 1) throw new Error('SETTINGS_MISSING');
      settings = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    const registry = registryFactory({ fetchImpl: observedFetch }).forState({ settings });
    const profile = registry.resolve(profileId);
    if (profile.provider !== 'gateway' || profile.demo || !safeId(profile.model)) throw new Error('LOCAL_PROFILE_REQUIRED');
    record({ stage: 'configured', profileId, model: profile.model, toolKey: safeId(profile.evaluator.toolKey),
      protocol: profile.evaluator.protocol === 'systemone' ? 'systemone' : 'chat',
      configurationHash: registry.snapshot(profile).configurationHash, synthetic: true, databaseWrites: false });
    // Bound this diagnostic independently of operational evaluations.
    const evaluator = profile.evaluator.withRuntime({ timeoutMs: 60000, maxTokens: 1024 });
    stage = 'discovery';
    const discovered = await evaluator.discovery();
    const native = evaluator.protocol === 'systemone';
    const present = native ? discovered?.model === profile.model
      : discovered?.models?.data?.some(model => model.id === profile.model);
    record({ stage: 'model-discovered', profileId, present: !!present, requestId: safeId(discovered?.requestId) });
    if (!present) throw new AppError(409, 'El modelo configurado no aparece en el inventario.', 'AI_CONFIGURATION');
    stage = 'synthetic-inference';
    const result = await evaluator.evaluate(structuredClone(conversation), structuredClone(variables));
    const item = result.results?.find(r => r.variableId === variables[0].id);
    const valid = result.model === profile.model && result.results?.length === 1 && !result.validationErrors?.length
      && !result.failure && item?.status === 'evaluado' && item.value === 1
      && item.evidence?.some(e => e.messageId === 'synthetic-client');
    const outcome = { success: !!valid, profileId, model: safeId(result.model), stage,
      requestId: safeId(result.responseId), responseField: ['content', 'reasoning_content'].includes(result.responseField) ? result.responseField : null,
      contractValid: !!valid, inferenceRequests, durationMs: Date.now() - started, synthetic: true, databaseWrites: false };
    record(outcome);
    return { ...outcome, events };
  } catch (error) {
    const outcome = { success: false, profileId, stage, code: codes.has(error.code) ? error.code : 'CONNECTIVITY_CHECK_FAILED',
      upstreamStatus: Number.isInteger(error.details?.upstreamStatus) ? error.details.upstreamStatus : null,
      inferenceRequests, durationMs: Date.now() - started, synthetic: true, databaseWrites: false };
    record(outcome);
    return { ...outcome, events };
  }
}

async function main(args) {
  if (args.length !== 1 || !allowedProfiles.has(args[0])) throw new Error('INVALID_ARGUMENTS');
  const { config, databaseConfig } = await import('../src/config.js');
  const { registryFromEnv } = await import('../src/model-registry.js');
  const { default: mysql } = await import('mysql2/promise');
  if (config.demo || !databaseConfig()) throw new Error('REAL_CONFIGURATION_REQUIRED');
  const { connectionLimit, ...options } = databaseConfig();
  const connection = await mysql.createConnection({ ...options, connectTimeout: 10000 });
  try {
    const result = await checkConnectivity({ connection, registryFactory: registryFromEnv, profileId: args[0] });
    process.exitCode = result.success ? 0 : 1;
  } finally { await connection.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error(JSON.stringify({ success: false, stage: 'setup', code: 'CONNECTIVITY_SETUP_FAILED', databaseWrites: false }));
    process.exitCode = 2;
  });
}
