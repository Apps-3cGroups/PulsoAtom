import { AppError } from './errors.js';

const rules = {
  num_mensajes_cliente(conversation) {
    const count = conversation.messages.filter(message => message.actor === 'cliente').length;
    return { status: 'evaluado', value: count, reason: `Se contaron ${count} mensajes del cliente en la transcripción de Atom.`, evidence: [] };
  },
};

export function supportsCodeVariable(variable) {
  return variable.method === 'Código' && variable.type === 'Métrica' && Object.hasOwn(rules, variable.id);
}

export function evaluateCodeVariable(conversation, variable) {
  if (!supportsCodeVariable(variable)) throw new AppError(422, `La variable ${variable.id} aún no tiene una regla de código implementada.`, 'UNSUPPORTED_VARIABLE');
  return { variableId: variable.id, ...rules[variable.id](conversation) };
}
