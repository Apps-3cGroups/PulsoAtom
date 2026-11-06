import { AppError } from './errors.js';
import { GatewayEvaluator } from './gateway-evaluator.js';
import { GatewayApiClient } from './services/gatewayApiClient.js';
import { digest } from './evaluation-context.js';

// Provider adapters implement configured + evaluate(conversation, variables).
// Gateway profiles keep local infrastructure and credentials in the backend.
export class ModelRegistry {
  constructor(profiles, { stateFactory, gatewayConfigured = false, localOnly = false } = {}) {
    if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('Los perfiles de IA deben tener IDs únicos.');
    this.profiles = profiles;
    this.stateFactory = stateFactory;
    this.gatewayConfigured = gatewayConfigured;
    this.localOnly = localOnly;
  }
  // Bind a fresh, immutable set of evaluators to persisted non-secret settings.
  // Running jobs retain their own configuration; a new request sees saved edits.
  forState(state) { return this.stateFactory ? this.stateFactory(state) : this; }
  localConfiguration(state) {
    const bound = this.forState(state);
    const policy = bound.policy(state);
    const profiles = bound.profiles.filter(p => p.provider === 'gateway').map(p => ({
      id: p.id, label: p.label, toolKey: p.evaluator.toolKey || '', model: p.model || '',
      enabled: !!p.enabled, responseFormat: p.evaluator.responseFormat,
    }));
    const policyReady = policy.mode === 'dual' && policy.primaryId === 'clef-local' && policy.secondaryId === 'gemma-local' && bound.policyAvailable(state);
    return { version: state?.settings?.localModelConfiguration?.version || 1,
      gatewayConfigured: bound.gatewayConfigured, profiles, policyReady };
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
    return { mode: this.localOnly ? 'dual' : 'single', secondaryId: this.localOnly ? 'gemma-local' : null,
      primaryId: this.profiles[0]?.id, fallbackId: null, version: 1, ...state?.settings?.aiPolicy };
  }
  policyAvailable(state) {
    const policy = this.policy(state);
    try {
      const profiles = [this.resolve(policy.primaryId)];
      if (policy.mode === 'dual') profiles.push(this.resolve(policy.secondaryId));
      else if (policy.fallbackId) profiles.push(this.resolve(policy.fallbackId));
      return new Set(profiles.map(p => `${p.provider}:${p.model}`)).size === profiles.length;
    } catch { return false; }
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
    { id: 'clef-local', label: 'Clef', provider: 'gateway', envPrefix: 'CLEF' },
    { id: 'gemma-local', label: 'Gemma', provider: 'gateway', envPrefix: 'GEMMA' },
  ];
  const specs = env.AI_MODEL_PROFILES ? JSON.parse(env.AI_MODEL_PROFILES) : defaults;
  if (!Array.isArray(specs) || !specs.length || specs.length > 12) throw new Error('AI_MODEL_PROFILES debe contener entre 1 y 12 perfiles.');
  if (new Set(specs.map(p => p?.id)).size !== specs.length) throw new Error('Los perfiles de IA deben tener IDs únicos.');
  for (const spec of specs) {
    if (!spec || !/^[a-z0-9-]{1,80}$/.test(spec.id) || !['openai', 'gemini', 'gateway'].includes(spec.provider) || !/^[A-Z][A-Z0-9_]*$/.test(spec.envPrefix) || (spec.model !== undefined && typeof spec.model !== 'string') || typeof spec.label !== 'string') throw new Error('Perfil de IA inválido.');
    if (spec.provider === 'gateway' && !defaults.some(p => p.id === spec.id)) throw new Error('Los perfiles locales de Pulso deben usar clef-local y gemma-local.');
  }
  // Public-provider environment variables may remain during deployment. They
  // must never reactivate cloud calls or replace either of the two local slots.
  const localSpecs = defaults.map(defaultSpec => ({ ...defaultSpec,
    ...specs.find(spec => spec.provider === 'gateway' && spec.id === defaultSpec.id), label: defaultSpec.label }));
  const gateway = { baseUrl: env.GATEWAY_BASE_URL, token: env.AGENT_SHARED_TOKEN,
    portalKey: env.GATEWAY_PORTAL_KEY ?? 'portal-pulso', fetchImpl };
  const gatewayConfigured = new GatewayApiClient(gateway).configured;
  const build = state => new ModelRegistry(localSpecs.map(spec => {
      const saved = state?.settings?.localModelConfiguration?.profiles?.find(p => p.id === spec.id);
      const prefix = spec.envPrefix;
      const model = saved?.model ?? spec.model ?? env[`${prefix}_MODEL`] ?? '';
      const evaluator = new GatewayEvaluator({ baseUrl: env.GATEWAY_BASE_URL, token: env.AGENT_SHARED_TOKEN,
        portalKey: gateway.portalKey, toolKey: saved?.toolKey ?? env[`${prefix}_TOOL_KEY`], model,
        timeoutMs: Number(env[`${prefix}_TIMEOUT_MS`] || 180000), maxTokens: Number(env[`${prefix}_MAX_TOKENS`] || 16000),
        temperature: Number(env[`${prefix}_TEMPERATURE`] || 0), responseFormat: saved?.responseFormat ?? env[`${prefix}_RESPONSE_FORMAT`] ?? 'json_schema', fetchImpl });
      return { ...spec, model, enabled: saved ? saved.enabled === true : env[`${prefix}_EVALUATION_ENABLED`] === 'true', evaluator };
  }), { stateFactory: build, gatewayConfigured, localOnly: true });
  return build();
}
