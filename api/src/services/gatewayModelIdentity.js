import { AppError } from '../errors.js';

const mismatch = () => new AppError(409, 'El servicio local respondió con un modelo distinto al solicitado. Revisa su configuración.', 'MODEL_CHANGED');
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/.test(value) && !value.includes('://');

// LM Studio may answer a model-key request with a numbered loaded instance.
// A suffix alone is never proof: authenticated native inventory must bind the
// exact returned instance to the exact requested artifact key, unambiguously.
export async function verifyNumberedModelInstance({ client, toolKey, requested, returned, responseRequestId }) {
  if (!id(requested) || !id(returned) || !returned.startsWith(requested)
    || !/^:[1-9][0-9]{0,6}$/.test(returned.slice(requested.length))) throw mismatch();
  const inventory = await client.invoke({ toolKey, method: 'GET', path: '/api/v1/models', operation: 'verificar-identidad-modelo' });
  const models = inventory.response?.models;
  if (!Array.isArray(models) || inventory.response.error || inventory.response.ok === false) throw mismatch();
  const matches = models.flatMap(model => Array.isArray(model?.loaded_instances)
    ? model.loaded_instances.filter(instance => instance?.id === returned).map(instance => ({ model, instance })) : []);
  if (matches.length !== 1 || matches[0].model.key !== requested || matches[0].model.type !== 'llm'
    || models.filter(model => model?.key === requested).length !== 1) throw mismatch();
  const contextLength = matches[0].instance.config?.context_length;
  return { modelKey: requested, instanceId: returned, inventoryRequestId: inventory.requestId, responseRequestId,
    ...(Number.isSafeInteger(contextLength) && contextLength > 0 ? { contextLength } : {}) };
}
