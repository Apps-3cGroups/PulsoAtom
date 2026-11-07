import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { catalogReferences, digest, evaluationContext, ensureEvaluationState } from './evaluation-context.js';
import { startEvaluationBatch, resumeEvaluationBatch } from './evaluation-service.js';

const fail = (code, message) => { throw new AppError(409, message, code); };
const readHistory = store => store.readWithConversations({ fresh: true });
const forState = (registry, state) => state !== undefined && registry.forState ? registry.forState(state) : registry;
const operator = { name: 'CLI · piloto local autorizado', id: null };
const probeVariables = [
  { id: 'local_probe_present', version: 1, type: 'Flag', method: 'IA', active: true,
    name: 'Prueba sintética positiva', definition: '1 si un mensaje del cliente contiene literalmente PRUEBA_POSITIVA_LOCAL; de lo contrario 0.' },
  { id: 'local_probe_absent', version: 1, type: 'Flag', method: 'IA', active: true,
    name: 'Prueba sintética negativa', definition: '1 si un mensaje del cliente contiene literalmente PRUEBA_AUSENTE_LOCAL; de lo contrario 0.' },
];
const probeConversation = { id: 'pulso-local-connectivity-synthetic', country: 'HN', completed: true, messages: [
  { id: 'probe-message-1', actor: 'cliente', text: 'Este es un ensayo sintético: PRUEBA_POSITIVA_LOCAL.', timestamp: '2026-01-01T12:00:00.000Z' },
  { id: 'probe-message-2', actor: 'humano', text: 'Recibí la prueba sintética.', timestamp: '2026-01-01T12:00:01.000Z' },
] };

export function localPilotProfiles(registry, state) {
  registry = forState(registry, state);
  const enabled = registry.list().filter(p => p.enabled);
  if (enabled.length !== 2 || enabled.some(p => !p.available || p.demo || p.provider !== 'gateway')) {
    fail('LOCAL_MODELS_REQUIRED', 'El piloto requiere exactamente dos perfiles locales habilitados y configurados; deshabilita los proveedores externos.');
  }
  if (new Set(enabled.map(p => p.model)).size !== 2) fail('DUPLICATE_MODEL', 'Los dos perfiles deben identificar modelos distintos.');
  return enabled.map(p => registry.resolve(p.id, p));
}

// Only this explicitly synthetic transcript is sent during preflight. No source
// conversation is read or evaluated until both services pass these checks.
export async function preflightLocalModels(registry, state) {
  registry = forState(registry, state);
  const profiles = localPilotProfiles(registry);
  const checks = [];
  for (const profile of profiles) {
    if (typeof profile.evaluator.discovery !== 'function') fail('LOCAL_DISCOVERY_REQUIRED', 'El adaptador local no admite la comprobación del Gateway.');
    const discovery = await profile.evaluator.discovery();
    const native = profile.evaluator.protocol === 'systemone';
    if (native) {
      // Native discovery already invokes the Gateway's read-only inventory and
      // verifies the exact loaded instance. It does not return a chat catalog.
      if (discovery?.type !== 'decision' || discovery.model !== profile.model
        || !Number.isSafeInteger(discovery.contextLength) || discovery.contextLength <= 0
        || !discovery.requestId) fail('LOCAL_MODEL_UNAVAILABLE', 'Clef no confirmó una instancia de decisiones cargada con capacidad de contexto conocida.');
    } else {
      const catalog = discovery.catalog;
      const tools = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.tools) ? catalog.tools : Array.isArray(catalog?.data) ? catalog.data : null;
      if (!tools) fail('GATEWAY_CATALOG_INVALID', 'El catálogo del Gateway tiene un formato no reconocido.');
      const tool = tools.find(item => item?.key === profile.evaluator.toolKey);
      if (!tool || tool.status !== 'active') fail('GATEWAY_TOOL_UNAVAILABLE', 'La herramienta configurada no está activa en el catálogo del Gateway.');
      if (!Array.isArray(discovery.models?.data) || !discovery.models.data.some(model => model?.id === profile.model)) {
        fail('LOCAL_MODEL_UNAVAILABLE', 'El modelo exacto configurado no aparece entre los modelos disponibles de la herramienta.');
      }
    }
    const response = await profile.evaluator.evaluate(structuredClone(probeConversation), structuredClone(probeVariables));
    const present = response.results?.find(r => r.variableId === 'local_probe_present');
    const absent = response.results?.find(r => r.variableId === 'local_probe_absent');
    if (response.model !== profile.model || response.validationErrors?.length || response.results?.length !== 2
      || present?.status !== 'evaluado' || present.value !== 1 || present.error
      || !present.evidence?.some(e => e.messageId === 'probe-message-1')
      || absent?.status !== 'evaluado' || absent.value !== 0 || absent.error) {
      fail('LOCAL_PREFLIGHT_FAILED', 'El modelo no superó la prueba sintética de formato, identidad y evidencia; no se modifica la base.');
    }
    if (native && (response.protocol !== 'systemone' || response.adapterVersion !== profile.evaluator.adapterVersion
      || !/^[a-f0-9]{64}$/.test(response.instructionsHash || '') || response.instructionsHash !== profile.evaluator.instructionsHash
      || present.reasonSource !== 'adapter_template' || present.evidenceSource !== 'model_choice'
      || present.explanationType !== 'typed_decision')) {
      fail('LOCAL_PREFLIGHT_FAILED', 'Clef no confirmó la procedencia de su decisión y de la evidencia seleccionada; no se modifica la base.');
    }
    checks.push({ profileId: profile.id, model: profile.model, configurationHash: registry.snapshot(profile).configurationHash,
      discoveryRequestId: discovery.requestId, probeRequestId: response.responseId,
      ...(native ? { protocol: 'systemone', adapterVersion: response.adapterVersion, instructionsHash: response.instructionsHash } : {}) });
  }
  return { checkedAt: new Date().toISOString(), synthetic: true, checks };
}

function lastActivity(conversation) {
  const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const explicit = validTime(conversation.lastActivityAt);
  if (explicit !== null) return explicit;
  const times = [conversation.endedAt, conversation.startedAt, ...conversation.messages.map(m => m.timestamp)].map(validTime).filter(t => t !== null);
  return times.reduce((latest, value) => Math.max(latest, value), -Infinity);
}
export function latestFiveConversations(conversations) {
  const selected = conversations.filter(c => c.messages?.length).sort((a, b) => {
    const delta = lastActivity(b) - lastActivity(a);
    if (Number.isFinite(delta) && delta !== 0) return delta;
    if (lastActivity(a) !== lastActivity(b)) return lastActivity(a) < lastActivity(b) ? 1 : -1;
    return String(b.id).localeCompare(String(a.id), 'en', { numeric: true });
  }).slice(0, 5);
  if (selected.length !== 5 || new Set(selected.map(c => c.id)).size !== 5 || selected.some(c => !Number.isFinite(lastActivity(c)))) {
    fail('LOCAL_SAMPLE_UNAVAILABLE', 'Se requieren cinco conversaciones distintas con mensajes y fecha de actividad válida.');
  }
  return selected;
}

export function createLocalPilotPlan(state, registry, preflight, { createdAt = new Date().toISOString(), maintenanceId } = {}) {
  registry = forState(registry, state);
  const profiles = localPilotProfiles(registry);
  if (state.metadata?.demo !== false) fail('REAL_MODE_REQUIRED', 'El piloto requiere el origen real de Pulso.');
  if (state.settings.evaluationMaintenance || maintenanceId) {
    if (!maintenanceId || state.settings.evaluationMaintenance !== maintenanceId || state.settings.dailyEnabled
      || ['evaluations', 'jobs', 'tasks', 'operationalRefs'].some(key => state[key]?.length)) {
      fail('MAINTENANCE_ALREADY_ACTIVE', 'Solo se puede preparar otra muestra durante el mismo mantenimiento si el diario está pausado y aún no existen evaluaciones ni ejecuciones.');
    }
  }
  if (state.jobs.some(j => j.status === 'running')) fail('EVALUATION_RUNNING', 'Hay una evaluación en curso.');
  if (!preflight?.synthetic || preflight.checks?.length !== 2 || profiles.some(p => !preflight.checks.some(c => c.profileId === p.id && c.model === p.model
    && c.configurationHash === registry.snapshot(p).configurationHash))) {
    fail('LOCAL_PREFLIGHT_REQUIRED', 'Primero verifica ambos modelos con la prueba sintética.');
  }
  return { format: 1, id: randomUUID(), createdAt, maintenanceId: maintenanceId || null, status: 'planned', selection: 'Última actividad descendente; ID descendente en empate',
    profiles: profiles.map(p => registry.snapshot(p)), catalogHash: digest(catalogReferences(state.catalog)), preflight,
    conversations: latestFiveConversations(state.conversations).map(c => ({ id: c.id, country: c.country,
      lastActivityAt: new Date(lastActivity(c)).toISOString(), messages: c.messages.length, ...evaluationContext(c, state.catalog) })) };
}

function validatePlan(state, registry, manifest, maintenanceId) {
  registry = forState(registry, state);
  const profiles = localPilotProfiles(registry);
  if (manifest?.format !== 1 || typeof manifest.id !== 'string' || !/^[0-9a-f-]{36}$/.test(manifest.id)
    || !Array.isArray(manifest.conversations) || manifest.conversations.length !== 5
    || new Set(manifest.conversations.map(c => c.id)).size !== 5 || manifest.profiles?.length !== 2) fail('INVALID_LOCAL_MANIFEST', 'El manifiesto del piloto no es válido.');
  if (state.metadata?.demo !== false) fail('REAL_MODE_REQUIRED', 'El piloto requiere el origen real de Pulso.');
  if (!maintenanceId || state.settings.evaluationMaintenance !== maintenanceId || (manifest.maintenanceId && manifest.maintenanceId !== maintenanceId)) fail('LOCAL_RESET_REQUIRED', 'Se requiere el mantenimiento explícito del reinicio respaldado.');
  if (state.settings.dailyEnabled) fail('DAILY_MUST_BE_PAUSED', 'Pausa la programación diaria antes de ejecutar el piloto.');
  if (state.jobs.some(j => j.status === 'running')) fail('EVALUATION_RUNNING', 'Hay una evaluación en curso.');
  if (manifest.catalogHash !== digest(catalogReferences(state.catalog))) fail('CATALOG_CHANGED', 'El checklist cambió después de preparar la muestra.');
  for (const expected of manifest.profiles) {
    if (!profiles.some(p => p.id === expected.id)) fail('MODEL_CHANGED', 'Los perfiles configurados ya no corresponden al manifiesto.');
    registry.resolve(expected.id, expected);
  }
  for (const expected of manifest.conversations) {
    const conversation = state.conversations.find(c => c.id === expected.id);
    if (!conversation?.messages.length) fail('SOURCE_CHANGED', 'Una conversación de la muestra ya no está disponible.');
    const context = evaluationContext(conversation, state.catalog);
    if (['sourceHash', 'catalogHash', 'promptHash', 'rulesVersion'].some(k => !expected[k] || expected[k] !== context[k])) {
      fail('SOURCE_CHANGED', 'El contenido, checklist o instrucciones de la muestra cambiaron. Prepara una muestra nueva antes de evaluar.');
    }
  }
  return manifest.profiles.map(p => registry.resolve(p.id, p));
}

export async function executeLocalPilot(store, registry, manifest, { maintenanceId, resume = false, onJob = async () => {} } = {}) {
  let state = ensureEvaluationState(await readHistory(store));
  const profiles = validatePlan(state, registry, manifest, maintenanceId);
  const existing = state.jobs.find(j => j.idempotencyKey === manifest.id);
  if (!existing && resume) fail('LOCAL_JOB_MISSING', 'No existe una ejecución para reanudar este manifiesto.');
  if (existing && !resume && existing.status !== 'completed') fail('LOCAL_RESUME_REQUIRED', 'El piloto ya se inició. Usa --resume con el mismo manifiesto.');
  if (!existing) {
    if (state.jobs.length || state.evaluations.length || state.tasks.length || state.operationalRefs.length) {
      fail('LOCAL_RESET_REQUIRED', 'El piloto inicial requiere las tablas de evaluaciones vacías tras el reinicio respaldado.');
    }
    await store.transaction(draft => {
      ensureEvaluationState(draft);
      validatePlan({ ...draft, conversations: state.conversations }, registry, manifest, maintenanceId);
      if (draft.jobs.length || draft.evaluations.length || draft.tasks.length || draft.operationalRefs.length) fail('LOCAL_RESET_REQUIRED', 'El estado cambió después del reinicio.');
      const current = forState(registry, draft).policy(draft);
      if (!draft.modelPolicies.some(p => p.version === current.version)) draft.modelPolicies.push({ id: String(current.version), ...current });
      const policy = { mode: 'dual', primaryId: profiles[0].id, secondaryId: profiles[1].id, fallbackId: null,
        version: current.version + 1, updatedAt: new Date().toISOString(), updatedBy: operator.name, updatedById: operator.id, localPilotId: manifest.id };
      draft.settings = { ...draft.settings, aiPolicy: policy, dailyEnabled: false, localPilotId: manifest.id, version: draft.settings.version + 1 };
      draft.modelPolicies.push({ id: String(policy.version), ...policy });
    });
  } else if (existing.maintenanceId !== maintenanceId || existing.mode !== 'dual' || existing.purpose !== 'operational'
    || existing.conversationIds.join(',') !== manifest.conversations.map(c => c.id).join(',')
    || existing.modelProfiles?.map(p => p.id).join(',') !== manifest.profiles.map(p => p.id).join(',')) {
    fail('LOCAL_JOB_MISMATCH', 'La ejecución guardada no pertenece a este piloto.');
  }
  const launch = existing
    ? existing.status === 'completed' ? { job: existing, completion: Promise.resolve(existing) } : await resumeEvaluationBatch(store, registry, existing.id)
    : await startEvaluationBatch(store, registry, { purpose: 'operational', conversationIds: manifest.conversations.map(c => c.id),
      pendingOnly: false, includeOpen: true, max: 5, concurrency: 1, maintenanceId, idempotencyKey: manifest.id });
  try { await onJob(launch.job); }
  catch (error) { await launch.completion; throw error; }
  await launch.completion;
  state = await readHistory(store);
  validatePlan(state, registry, manifest, maintenanceId);
  const job = state.jobs.find(j => j.id === launch.job.id);
  const tasks = state.tasks.filter(t => t.jobId === job.id);
  const summary = { jobId: job.id, status: job.status, conversations: 5, expectedReviews: 10,
    completed: tasks.filter(t => t.status === 'completed').length, partial: tasks.filter(t => t.status === 'partial').length,
    failed: tasks.filter(t => t.status === 'failed').length, dailyEnabled: false,
    errors: tasks.filter(t => t.error).map(t => ({ conversationId: t.conversationId, profileId: t.profile.id, code: t.error.code })) };
  if (job.status === 'completed' && summary.completed === 10 && tasks.length === 10) {
    for (const c of manifest.conversations) {
      const evaluations = tasks.filter(t => t.conversationId === c.id).map(t => state.evaluations.find(e => e.id === t.evaluationId));
      if (evaluations.length !== 2 || evaluations.some(e => !e || e.provider !== 'gateway' || e.usedFallback
        || !manifest.profiles.some(p => p.id === e.profileId && p.model === e.model)
        || ['sourceHash', 'catalogHash', 'promptHash', 'rulesVersion'].some(k => e[k] !== c[k]))
        || new Set(evaluations.map(e => e.model)).size !== 2) fail('LOCAL_RESULTS_INVALID', 'La identidad o equivalencia de los resultados requiere revisión; se conserva el mantenimiento.');
    }
    await store.transaction(draft => {
      if (draft.settings.evaluationMaintenance !== maintenanceId || draft.settings.localPilotId !== manifest.id
        || draft.settings.dailyEnabled || draft.jobs.find(j => j.id === job.id)?.status !== 'completed'
        || draft.jobs.some(j => j.status === 'running') || draft.settings.aiPolicy?.mode !== 'dual'
        || draft.settings.aiPolicy.primaryId !== profiles[0].id || draft.settings.aiPolicy.secondaryId !== profiles[1].id
        || draft.settings.aiPolicy.fallbackId !== null) fail('LOCAL_STATE_CHANGED', 'La configuración cambió durante el piloto; se requiere revisión antes de cerrar el mantenimiento.');
      draft.settings = { ...draft.settings, evaluationMaintenance: null, resetPreviousDailyEnabled: undefined,
        dailyEnabled: false, lastLocalPilotId: manifest.id, lastLocalPilotCompletedAt: new Date().toISOString(), version: draft.settings.version + 1 };
    });
    summary.maintenanceReleased = true;
  } else summary.maintenanceReleased = false;
  return summary;
}
