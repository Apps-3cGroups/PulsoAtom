import { z } from 'zod';
import { AppError } from './errors.js';
import { GatewayApiClient } from './services/gatewayApiClient.js';
import { getLoadedDecisionInstance } from './services/gatewayDecisionDiscovery.js';
import { discoverGatewayModels, discoverGatewayTools, gatewayModelIdPattern, gatewayToolKeyPattern } from './services/gatewayDiscovery.js';

const profileIds = ['clef-local', 'gemma-local'];
const names = { 'clef-local': 'Clef', 'gemma-local': 'Gemma' };
const profileSchema = z.object({
  id: z.enum(profileIds), toolKey: z.string().trim().regex(gatewayToolKeyPattern),
  model: z.string().trim().regex(gatewayModelIdPattern).refine(value => !value.includes('://'), 'Selecciona un identificador de modelo.'),
  enabled: z.boolean(), responseFormat: z.enum(['json_schema', 'json_object']),
  protocol: z.enum(['chat', 'systemone']).default('chat'),
}).strict().refine(profile => profile.protocol === 'chat' || profile.id === 'clef-local', 'El protocolo de decisiones está disponible para Clef.')
  .transform(profile => profile.protocol === 'systemone' ? { ...profile, responseFormat: 'json_schema' } : profile);
const configurationSchema = z.object({ expectedVersion: z.number().int().positive(), profiles: z.array(profileSchema).length(2) })
  .strict().refine(value => new Set(value.profiles.map(p => p.id)).size === 2, 'Configura Clef y Gemma una sola vez.');
const emptyQuery = z.object({}).strict();

function assertMutable(state, expectedVersion) {
  if (state.settings.evaluationMaintenance) throw new AppError(409, 'Finaliza el mantenimiento de evaluaciones antes de cambiar los modelos.', 'EVALUATION_MAINTENANCE');
  if (state.jobs.some(job => ['running', 'queued'].includes(job.status))) throw new AppError(409, 'Espera a que termine la ejecución en curso antes de cambiar los modelos.', 'EVALUATION_RUNNING');
  if ((state.settings.localModelConfiguration?.version || 1) !== expectedVersion) throw new AppError(409, 'La configuración cambió. Recarga antes de guardar.', 'VERSION_CONFLICT');
}
const onlyDisabling = (previous, next) => next.some(p => previous.find(old => old.id === p.id)?.enabled && !p.enabled)
  && next.every(p => {
    const old = previous.find(item => item.id === p.id);
    return old && old.toolKey === p.toolKey && old.model === p.model && old.responseFormat === p.responseFormat && (old.protocol || 'chat') === p.protocol && (!p.enabled || old.enabled);
  });

export function mountLocalModelConfigurationRoutes(app, prefix, { store, registry, config, requireAdmin,
  gatewayEnv = process.env, gatewayFetchImpl = fetch }) {
  const realOnly = () => {
    if (config.demo) throw new AppError(409, 'La demostración no consulta ni configura el Gateway real. Realiza esta configuración en el portal conectado.', 'DEMO_MODE');
  };
  const snapshot = state => {
    const value = registry.localConfiguration(state);
    return { version: value.version, gatewayConfigured: !config.demo && value.gatewayConfigured,
      profiles: value.profiles.map(p => ({ id: p.id, label: names[p.id], toolKey: p.toolKey, model: p.model, enabled: p.enabled, responseFormat: p.responseFormat, protocol: p.protocol || 'chat', explanationType: p.explanationType })),
      policyReady: !config.demo && value.policyReady };
  };
  app.get(`${prefix}/models/local-configuration`, requireAdmin, async (req, res) => {
    emptyQuery.parse(req.query);
    res.set('Cache-Control', 'no-store').json(snapshot(await store.read()));
  });
  app.get(`${prefix}/models/gateway/tools`, requireAdmin, async (req, res) => {
    emptyQuery.parse(req.query); realOnly();
    res.set('Cache-Control', 'no-store').json(await discoverGatewayTools({ env: gatewayEnv, fetchImpl: gatewayFetchImpl }));
  });
  app.get(`${prefix}/models/gateway/tools/:toolKey/models`, requireAdmin, async (req, res) => {
    emptyQuery.parse(req.query); realOnly();
    const toolKey = z.string().regex(gatewayToolKeyPattern).parse(req.params.toolKey);
    res.set('Cache-Control', 'no-store').json(await discoverGatewayModels({ toolKey, env: gatewayEnv, fetchImpl: gatewayFetchImpl }));
  });
  app.put(`${prefix}/models/local-configuration`, requireAdmin, async (req, res) => {
    emptyQuery.parse(req.query); realOnly();
    const input = configurationSchema.parse(req.body);
    if (input.profiles[0].model === input.profiles[1].model) throw new AppError(422, 'Selecciona dos modelos distintos para Clef y Gemma.', 'DUPLICATE_MODEL');
    const before = await store.read();
    assertMutable(before, input.expectedVersion);
    const previous = snapshot(before);
    const disabling = onlyDisabling(previous.profiles, input.profiles);
    const validation = [];
    if (!disabling) {
      const { tools } = await discoverGatewayTools({ env: gatewayEnv, fetchImpl: gatewayFetchImpl });
      const modelsByTool = new Map();
      for (const profile of input.profiles) {
        if (!modelsByTool.has(profile.toolKey)) {
          const discovered = await discoverGatewayModels({ toolKey: profile.toolKey, tools, env: gatewayEnv, fetchImpl: gatewayFetchImpl });
          modelsByTool.set(profile.toolKey, discovered.models);
          validation.push({ toolKey: profile.toolKey, requestId: discovered.request_uuid });
        }
        if (!modelsByTool.get(profile.toolKey).includes(profile.model)) throw new AppError(409, 'Uno de los modelos seleccionados ya no está disponible en su herramienta. Actualiza el catálogo del Gateway.', 'MODEL_UNAVAILABLE');
        if (profile.protocol === 'systemone') {
          const tool = tools.find(item => item.key === profile.toolKey);
          if (!tool?.protocols?.includes('systemone')) throw new AppError(409,
            'Esta herramienta no publica las rutas System One y de inventario nativo requeridas para Clef. Habilítalas en el Gateway y vuelve a consultar.', 'AI_CONFIGURATION');
          const client = new GatewayApiClient({ baseUrl: gatewayEnv.GATEWAY_BASE_URL, token: gatewayEnv.AGENT_SHARED_TOKEN,
            portalKey: gatewayEnv.GATEWAY_PORTAL_KEY ?? 'portal-pulso', timeoutMs: 15000, fetchImpl: gatewayFetchImpl });
          const instance = await getLoadedDecisionInstance({ client, toolKey: profile.toolKey, model: profile.model });
          validation.push({ toolKey: profile.toolKey, protocol: 'systemone', model: instance.model, type: instance.type,
            modelKey: instance.modelKey, contextLength: instance.contextLength, requestId: instance.requestId });
        }
      }
    }
    const result = await store.transaction(state => {
      assertMutable(state, input.expectedVersion);
      // A concurrent change cannot turn an upstream-free deactivation into an
      // activation or a model replacement.
      if (disabling && !onlyDisabling(snapshot(state).profiles, input.profiles)) throw new AppError(409, 'La configuración cambió. Recarga antes de guardar.', 'VERSION_CONFLICT');
      const updatedAt = new Date().toISOString();
      const history = state.settings.localModelConfigurationHistory ||= [];
      const prior = state.settings.localModelConfiguration || { version: previous.version, profiles: previous.profiles, source: 'environment', capturedAt: updatedAt };
      if (!history.some(item => item.version === prior.version)) history.push(structuredClone(prior));
      const saved = { version: input.expectedVersion + 1,
        profiles: profileIds.map(id => ({ ...input.profiles.find(p => p.id === id), label: names[id] })),
        updatedAt, updatedBy: req.user.name, updatedById: req.user.id, validation,
        validationMode: disabling ? 'deactivation-only' : 'gateway-catalog' };
      state.settings.localModelConfiguration = saved;
      history.push(structuredClone(saved));
      const policies = state.modelPolicies ||= [];
      const current = registry.forState(state).policy(state);
      if (!policies.some(p => p.version === current.version)) policies.push({ id: String(current.version), ...current });
      state.settings.aiPolicy = { mode: 'dual', primaryId: 'clef-local', secondaryId: 'gemma-local', fallbackId: null,
        version: current.version + 1, updatedAt, updatedBy: req.user.name, updatedById: req.user.id };
      policies.push({ id: String(state.settings.aiPolicy.version), ...state.settings.aiPolicy });
      state.settings.dailyEnabled = false;
      state.settings.version = (state.settings.version || 1) + 1;
      return snapshot(state);
    });
    res.set('Cache-Control', 'no-store').json(result);
  });
}
