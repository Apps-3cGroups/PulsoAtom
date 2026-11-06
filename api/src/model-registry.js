import { AppError } from './errors.js';
import { OpenAIEvaluator } from './evaluator.js';
import { GeminiEvaluator } from './gemini-evaluator.js';
import { GatewayEvaluator } from './gateway-evaluator.js';
import { digest } from './evaluation-context.js';

// Provider adapters implement configured + evaluate(conversation, variables).
// Gateway profiles keep local infrastructure and credentials in the backend.
export class ModelRegistry {
  constructor(profiles) {
    if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('Los perfiles de IA deben tener IDs únicos.');
    this.profiles = profiles;
  }
  get configured() { return this.profiles.some(p => p.enabled && p.evaluator?.configured); }
  list() { return this.profiles.map(p => ({ ...this.snapshot(p), configured: !!p.evaluator?.configured,
    enabled: !!p.enabled, available: !!(p.enabled && p.evaluator?.configured) })); }
  snapshot(p) {
    // Preserve hashes of existing providers; local routes and generation options
    // are part of a gateway profile's identity. Credentials never enter snapshots.
    const settings = [p.provider, p.model, p.evaluator?.baseUrl, p.evaluator?.timeoutMs];
    if (p.provider === 'gateway') settings.push({ toolKey: p.evaluator.toolKey, portalKey: p.evaluator.portalKey,
      responseFormat: p.evaluator.responseFormat, maxTokens: p.evaluator.maxTokens, temperature: p.evaluator.temperature });
    const configurationHash = digest(settings); return { id: p.id, viewId: `${p.id}@${configurationHash}`, label: p.label, provider: p.provider, model: p.model,
    configurationHash, demo: !!p.demo }; }
  resolve(id, expected) {
    const p = this.profiles.find(p => p.id === id);
    if (!p?.enabled || !p.evaluator?.configured) throw new AppError(409, 'El modelo está deshabilitado o pendiente de configuración.', 'AI_CONFIGURATION');
    if (expected && expected.configurationHash !== this.snapshot(p).configurationHash) throw new AppError(409, 'La configuración del modelo cambió. Crea una nueva ejecución.', 'MODEL_CHANGED');
    return p;
  }
  policy(state) {
    return { mode: 'single', secondaryId: null, primaryId: this.profiles[0]?.id, fallbackId: null, version: 1, ...state.settings.aiPolicy };
  }
}
export function asRegistry(evaluator) {
  if (evaluator instanceof ModelRegistry) return evaluator;
  const provider = evaluator instanceof GatewayEvaluator ? 'gateway' : 'openai';
  return new ModelRegistry([{ id: `${provider}-default`, label: evaluator.model || (provider === 'gateway' ? 'Modelo local' : 'OpenAI'), provider,
    model: evaluator.model || 'configured-model', enabled: true, evaluator }]);
}
export function registryFromEnv({ demo = false, env = process.env, fetchImpl = fetch } = {}) {
  if (demo) return new ModelRegistry(['GPT', 'Gemini', 'Local'].map((label, index) => ({
    id: `demo-${label.toLowerCase()}`, label: `${label} · demo`, model: `synthetic-${index + 1}`, provider: 'demo', enabled: true, demo: true,
    evaluator: { configured: true, async evaluate(conversation, variables) {
      return { model: `synthetic-${index + 1}`, responseId: null, usage: null,
        results: variables.map(variable => {
          const number = parseInt(digest([conversation.id, variable.id]).slice(0, 5), 16);
          const abstain = (number + index) % 41 === 0;
          const value = abstain ? null : variable.type === 'Descriptor'
            ? variable.id === 'tipo_interaccion' ? 'pedido' : ['Producto sintético de demostración']
            : Number(number % 7 === 0 || (index === 1 && number % 11 === 0));
          const message = conversation.messages[Math.min(3, conversation.messages.length - 1)];
          return { variableId: variable.id, type: variable.type, method: variable.method, status: abstain ? 'no_evaluado' : 'evaluado', value,
            reason: 'Resultado sintético para probar la comparación. No es una evaluación real de IA.', evidence: value ? [{ messageId: message.id, quote: message.text }] : [] };
        }) };
    } },
  })));
  const defaults = [
    { id: 'openai-default', label: 'GPT', provider: 'openai', model: env.OPENAI_MODEL || '', envPrefix: 'OPENAI' },
    { id: 'gemini-default', label: 'Gemini', provider: 'gemini', model: env.GEMINI_MODEL || '', envPrefix: 'GEMINI' },
  ];
  const specs = env.AI_MODEL_PROFILES ? JSON.parse(env.AI_MODEL_PROFILES) : defaults;
  if (!Array.isArray(specs) || !specs.length || specs.length > 12) throw new Error('AI_MODEL_PROFILES debe contener entre 1 y 12 perfiles.');
  return new ModelRegistry(specs.map(spec => {
    if (!spec || !/^[a-z0-9-]{1,80}$/.test(spec.id) || !['openai', 'gemini', 'gateway'].includes(spec.provider) || !/^[A-Z][A-Z0-9_]*$/.test(spec.envPrefix) || (spec.model !== undefined && typeof spec.model !== 'string') || typeof spec.label !== 'string') throw new Error('Perfil de IA inválido.');
    const prefix = spec.envPrefix;
    const model = spec.model ?? env[`${prefix}_MODEL`] ?? '';
    if (spec.provider === 'gateway') {
      const evaluator = new GatewayEvaluator({ baseUrl: env.GATEWAY_BASE_URL, token: env.AGENT_SHARED_TOKEN,
        portalKey: env.GATEWAY_PORTAL_KEY, toolKey: env[`${prefix}_TOOL_KEY`], model,
        timeoutMs: Number(env[`${prefix}_TIMEOUT_MS`] || 180000), maxTokens: Number(env[`${prefix}_MAX_TOKENS`] || 16000),
        temperature: Number(env[`${prefix}_TEMPERATURE`] || 0), responseFormat: env[`${prefix}_RESPONSE_FORMAT`] || 'json_schema', fetchImpl });
      return { ...spec, model, enabled: env[`${prefix}_EVALUATION_ENABLED`] === 'true', evaluator };
    }
    const options = { apiKey: env[`${prefix}_API_KEY`], baseUrl: env[`${prefix}_BASE_URL`], model,
      timeoutMs: Math.min(180000, Math.max(1000, Number(env[`${prefix}_TIMEOUT_MS`]) || 120000)), fetchImpl };
    if (spec.provider === 'openai' && !options.baseUrl) options.baseUrl = 'https://api.openai.com/v1';
    return { ...spec, model, enabled: env[`${prefix}_EVALUATION_ENABLED`] === 'true', evaluator: spec.provider === 'openai' ? new OpenAIEvaluator(options) : new GeminiEvaluator(options) };
  }));
}
