import { AppError } from '../errors.js';

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/;
const validId = value => typeof value === 'string' && identifier.test(value) && !value.includes('://');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const invalid = () => new AppError(502, 'El inventario nativo no permitió verificar la instancia de decisiones de Clef.', 'INVALID_GATEWAY_CATALOG');

// The OpenAI-compatible /v1/models list only proves an ID is published. Native
// LM Studio metadata proves the exact loaded instance is a decision model. No
// provider URL, file path, prompt or credential from this inventory is exposed.
export async function getLoadedDecisionInstance({ client, toolKey, model }) {
  if (!validId(model)) throw new AppError(422, 'Selecciona el identificador exacto de la instancia de Clef.', 'AI_CONFIGURATION');
  const result = await client.invoke({ toolKey, method: 'GET', path: '/api/v1/models', operation: 'verificar-modelo-decisiones' });
  if (!object(result.response) || !Array.isArray(result.response.models) || result.response.error || result.response.ok === false) throw invalid();
  const matches = [];
  for (const entry of result.response.models) {
    if (!object(entry) || !Array.isArray(entry.loaded_instances)) throw invalid();
    for (const instance of entry.loaded_instances) {
      if (!object(instance) || !validId(instance.id)) throw invalid();
      if (instance.id === model) matches.push({ entry, instance });
    }
  }
  if (matches.length === 0) throw new AppError(409, 'La instancia seleccionada de Clef no está cargada. Selecciona su ID cargado antes de evaluar.', 'MODEL_UNAVAILABLE');
  if (matches.length !== 1) throw invalid();
  const { entry, instance } = matches[0];
  if (entry.type !== 'decision') throw new AppError(409, 'La instancia de Clef está publicada como chat. El protocolo de decisiones requiere cargar el modelo completo como decision.', 'AI_CONFIGURATION');
  if (!validId(entry.key) || !object(instance.config) || !positiveInt(instance.config.context_length)) throw invalid();
  const decisionType = typeof entry.decision_type === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(entry.decision_type) ? entry.decision_type : undefined;
  return { model, modelKey: entry.key, type: 'decision', contextLength: instance.config.context_length,
    ...(decisionType ? { decisionType } : {}),
    ...(positiveInt(instance.config.eval_batch_size) ? { evalBatchSize: instance.config.eval_batch_size } : {}), requestId: result.requestId };
}
