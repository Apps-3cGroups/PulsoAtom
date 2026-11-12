import '../src/config.js';
import mysql from 'mysql2/promise';
import { databaseConfig } from '../src/config.js';
import { GatewayApiClient } from '../src/services/gatewayApiClient.js';
import { registryFromEnv } from '../src/model-registry.js';

const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const db = await mysql.createConnection(databaseConfig());
try {
  await db.query('START TRANSACTION READ ONLY');
  const [rows] = await db.query("SELECT payload FROM portal_settings WHERE id='settings'");
  const state = { settings: decode(rows[0].payload) };
  await db.commit();
  const registry = registryFromEnv().forState(state);
  const profile = registry.resolve('gemma-local');
  console.log(JSON.stringify({ stage: 'configured', profile: registry.snapshot(profile), toolKey: profile.evaluator.toolKey }));
  const client = new GatewayApiClient({ baseUrl: process.env.GATEWAY_BASE_URL, token: process.env.AGENT_SHARED_TOKEN,
    portalKey: process.env.GATEWAY_PORTAL_KEY || 'portal-pulso', timeoutMs: 30000 });
  const models = await client.invoke({ toolKey: profile.evaluator.toolKey, method: 'GET', path: '/v1/models', operation: 'preflight' });
  console.log(JSON.stringify({ stage: 'models', requestId: models.requestId, ids: (models.response.data || []).map(m => m.id) }));
  const native = await client.invoke({ toolKey: profile.evaluator.toolKey, method: 'GET', path: '/api/v1/models', operation: 'preflight' });
  console.log(JSON.stringify({ stage: 'native-instances', requestId: native.requestId,
    models: (native.response.models || []).map(m => ({ key: /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/.test(m.key || '') && !m.key.includes('://') ? m.key : null,
      type: ['llm', 'embedding', 'decision'].includes(m.type) ? m.type : null,
      maxContextLength: Number.isSafeInteger(m.max_context_length) ? m.max_context_length : null,
      loaded: (m.loaded_instances || []).map(i => ({ id: /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/.test(i.id || '') && !i.id.includes('://') ? i.id : null,
        contextLength: Number.isSafeInteger(i.config?.context_length) ? i.config.context_length : null,
        parallel: Number.isSafeInteger(i.config?.parallel) ? i.config.parallel : null })) })) }));
  const response = await client.invoke({ toolKey: profile.evaluator.toolKey, method: 'POST', path: '/v1/chat/completions', operation: 'preflight',
    body: { model: profile.model, messages: [{ role: 'user', content: 'Devuelve solamente el número 1.' }], temperature: 0, max_tokens: 16, stream: false } });
  console.log(JSON.stringify({ stage: 'synthetic-response', requestId: response.requestId, requested: profile.model,
    actual: response.response?.model, sameIdentity: response.response?.model === profile.model,
    finishReason: response.response?.choices?.[0]?.finish_reason, latencyMs: response.latencyMs }));
} catch (error) {
  console.error(JSON.stringify({ stage: 'error', code: error.code || 'INSPECTION_FAILED' }));
  process.exitCode = 1;
} finally { await db.end(); }
