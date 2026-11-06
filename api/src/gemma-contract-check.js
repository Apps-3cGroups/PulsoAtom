import { AppError } from './errors.js';
import { catalogReferences, digest } from './evaluation-context.js';
import { evaluationInstructions, evaluationSchema, evaluationValidationFeedback, PROMPT_VERSION, supportsAiVariable } from './evaluator.js';

// Fixed, synthetic source. The checker never accepts Atom messages as input.
export const gemmaContractConversation = {
  id: 'pulso-gemma-full-contract-synthetic', country: 'HN', completed: true,
  messages: [
    { id: 'synthetic-client-1', actor: 'cliente', timestamp: '2026-01-01T12:00:00.000Z',
      text: 'Hola, ¿tienen disponible ProductoPrueba? Solo consulto disponibilidad; no haré una compra.' },
    { id: 'synthetic-human-1', actor: 'humano', timestamp: '2026-01-01T12:01:00.000Z',
      text: 'Hola, sí tenemos disponible ProductoPrueba.' },
    { id: 'synthetic-client-2', actor: 'cliente', timestamp: '2026-01-01T12:02:00.000Z',
      text: 'Lo felicito por su excelente atención. Resolvió mi consulta y no necesito nada más.' },
    { id: 'synthetic-human-2', actor: 'humano', timestamp: '2026-01-01T12:03:00.000Z',
      text: 'Gracias por sus palabras. Que tenga un buen día.' },
  ],
};
const retryable = new Set(['AI_UNAVAILABLE', 'AI_TRANSIENT', 'INVALID_AI_RESULT', 'AI_INCOMPLETE']);
const safeErrorCodes = new Set([...retryable, 'AI_CONFIGURATION', 'MODEL_CHANGED', 'MODEL_IDENTITY_UNVERIFIED',
  'AI_SAFETY_REFUSAL', 'UNSUPPORTED_VARIABLE', 'EMPTY_CONVERSATION']);
const safeError = error => ({ code: error instanceof AppError && safeErrorCodes.has(error.code) ? error.code : 'GEMMA_CHECK_FAILED',
  message: 'No se completó la comprobación sintética. Revisa el código de error; no se guardaron evaluaciones.' });
const safeId = (value, redactions, pattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/) => typeof value === 'string'
  && pattern.test(value) && !value.includes('://') && !redactions.some(secret => secret && value.includes(secret)) ? value : null;
const semanticExpectations = [
  { variableId: 'tipo_interaccion', value: 'disponibilidad', evidenceId: 'synthetic-client-1' },
  { variableId: 'asistente_comunicacion_poco_profesional', value: 0 },
  { variableId: 'cliente_felicito_al_asistente', value: 1, evidenceId: 'synthetic-client-2' },
];

export async function checkGemmaContract({ registry, state, redactions = [] }) {
  const bound = registry.forState(state);
  const profile = bound.resolve('gemma-local');
  if (profile.provider !== 'gateway' || profile.demo) throw new AppError(409, 'La comprobación requiere Gemma local habilitada.', 'AI_CONFIGURATION');
  const model = safeId(profile.model, redactions, /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/);
  if (!model) throw new AppError(409, 'El identificador de Gemma no es válido para esta comprobación.', 'AI_CONFIGURATION');
  const variables = state.catalog.filter(v => v.active && !v.retired && supportsAiVariable(v));
  if (!variables.length || variables.some(v => !/^[a-z][a-z0-9_]{0,159}$/.test(v.id))
    || new Set(variables.map(v => v.id)).size !== variables.length) throw new AppError(409, 'El checklist activo no permite la comprobación.', 'UNSUPPORTED_VARIABLE');
  const results = new Map(), attempts = [];
  let validationErrors = [], lastError = null;
  for (let index = 0; index < 2; index++) {
    const pending = variables.filter(v => !results.has(v.id));
    if (!pending.length) break;
    const started = Date.now();
    try {
      const response = await profile.evaluator.evaluate(structuredClone(gemmaContractConversation), pending,
        { validationErrors: evaluationValidationFeedback(pending, validationErrors) });
      if (response.model !== profile.model) throw new AppError(409, 'El modelo efectivo cambió.', 'MODEL_CHANGED');
      if (!Array.isArray(response.results) || response.results.some(r => !pending.some(v => v.id === r.variableId))
        || new Set(response.results.map(r => r.variableId)).size !== response.results.length) throw new AppError(502, 'Respuesta inválida.', 'INVALID_AI_RESULT');
      for (const result of response.results) results.set(result.variableId, result);
      const remaining = variables.filter(v => !results.has(v.id));
      const feedback = evaluationValidationFeedback(remaining, response.validationErrors);
      validationErrors = remaining.map(v => feedback.find(e => e.variableId === v.id) || { variableId: v.id, rules: ['missing_item'] });
      lastError = null;
      attempts.push({ number: index + 1, requested: pending.length, valid: response.results.length,
        status: remaining.length ? 'partial' : 'completed', durationMs: Date.now() - started,
        responseId: safeId(response.responseId, redactions), validationErrors: structuredClone(validationErrors) });
    } catch (error) {
      lastError = safeError(error);
      attempts.push({ number: index + 1, requested: pending.length, valid: 0, status: 'failed',
        durationMs: Date.now() - started, responseId: null, error: lastError });
      if (!retryable.has(error.code)) break;
    }
  }
  const semanticChecks = semanticExpectations.map(expected => {
    const result = results.get(expected.variableId);
    const requested = variables.some(v => v.id === expected.variableId);
    return { variableId: expected.variableId, requested, passed: !!(requested && result?.status === 'evaluado'
      && result.value === expected.value && (expected.evidenceId ? result.evidence?.some(e => e.messageId === expected.evidenceId) : result.evidence?.length === 0)) };
  });
  const valid = [...results.values()];
  // Report the model's response, not an answer forced by a shared code rule.
  // In particular, a valid AI abstention must remain visible in this diagnostic.
  const aiAnswers = valid.map(result => result.aiResult || result);
  const contractValid = valid.length === variables.length && !lastError;
  const reasonableResults = semanticChecks.every(check => check.passed);
  return { success: contractValid && reasonableResults, synthetic: true, checkedAt: new Date().toISOString(),
    profileId: profile.id, model, configurationHash: bound.snapshot(profile).configurationHash,
    settingsVersion: state.settings?.version || 1, modelConfigurationVersion: state.settings?.localModelConfiguration?.version || 1,
    catalogHash: digest(catalogReferences(state.catalog)), schemaHash: digest(evaluationSchema(variables)),
    promptVersion: PROMPT_VERSION, promptHash: digest(evaluationInstructions),
    requested: variables.length, valid: valid.length, evaluated: aiAnswers.filter(r => r.status === 'evaluado').length,
    abstained: aiAnswers.filter(r => r.status === 'no_evaluado').length, invalid: variables.length - valid.length,
    sharedRuleResults: valid.filter(r => r.aiResult && r.codeRule).length,
    contractValid, reasonableResults, semanticChecks, attempts, validationErrors,
    error: lastError, note: 'Comprobación sintética de contrato y tres resultados conocidos. No mide precisión sobre conversaciones reales ni guarda evaluaciones.' };
}
