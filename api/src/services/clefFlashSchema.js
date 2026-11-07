import { AppError } from '../errors.js';
import { interactionTypes } from '../evaluator.js';

export const CLEF_FLASH_OUTPUT_SCHEMA_VERSION = 'clef-flash-schema-1';

// The output contract is unchanged: each branch encodes a combination already
// required by validateEvaluation. Separate object alternatives avoid conditional
// schema keywords and never reinterpret a model's decision after generation.
export function clefFlashEvaluationSchema(variables, conversation) {
  const messageIds = [...new Set(conversation.messages.map(message => message.id))];
  if (!messageIds.length || messageIds.some(id => typeof id !== 'string' || !id)) {
    throw new AppError(422, 'La conversación requiere identificadores de mensajes válidos.', 'INVALID_SOURCE');
  }
  const evidence = required => ({ type: 'array',
    items: { type: 'string', enum: messageIds }, minItems: required ? 1 : 0, maxItems: required ? 3 : 0 });
  const branch = (status, value, requiresEvidence) => ({ type: 'object', additionalProperties: false,
    properties: { status: { type: 'string', enum: [status] }, value,
      reason: { type: 'string', minLength: 1, maxLength: 1000 }, evidence_message_ids: evidence(requiresEvidence) },
    required: ['status', 'value', 'reason', 'evidence_message_ids'] });
  const abstention = () => branch('no_evaluado', { type: 'null' }, false);
  const item = variable => {
    if (variable.type !== 'Descriptor') return { anyOf: [
      branch('evaluado', { type: 'integer', enum: [1] }, true),
      branch('evaluado', { type: 'integer', enum: [0] }, false), abstention(),
    ] };
    if (variable.id === 'tipo_interaccion') return { anyOf: [
      branch('evaluado', { type: 'string', enum: interactionTypes }, true), abstention(),
    ] };
    if (variable.id === 'productos_solicitados') {
      const products = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 300 } };
      return { anyOf: [branch('evaluado', { ...products, minItems: 1, maxItems: 100 }, true),
        branch('evaluado', { ...products, minItems: 0, maxItems: 0 }, false), abstention()] };
    }
    throw new AppError(422, 'El checklist incluye un descriptor no admitido.', 'UNSUPPORTED_VARIABLE');
  };
  return { type: 'object', additionalProperties: false, properties: {
    results: { type: 'object', additionalProperties: false,
      properties: Object.fromEntries(variables.map(variable => [variable.id, item(variable)])),
      required: variables.map(variable => variable.id) },
  }, required: ['results'] };
}
