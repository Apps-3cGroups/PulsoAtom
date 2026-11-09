import { messageCounts } from './message-counts.js';
import { AppError } from './errors.js';

export const CODE_RULES_VERSION = 'pulso-code-v5-2026-11-03';
const assistant = m => ['humano', 'bot'].includes(m.actor);
const evidence = messages => messages.map(m => ({ messageId: m.id, quote: String(m.text || '').slice(0, 2000) }));
const result = (value, reason, extra = {}) => ({ status: 'evaluado', value, reason, evidence: [], ...extra });
const unavailable = (reason, unavailableReason, extra = {}) => ({ status: 'no_evaluado', value: null, reason, unavailableReason, evidence: [], ...extra });
const normalized = value => String(value || '').normalize('NFKC').toLocaleLowerCase('es').replace(/\s+/gu, ' ').trim();
const numbers = value => value.match(/[+-]?\d+(?:[.,]\d+)*/gu) || [];
const negations = value => value.match(/\b(?:no|nunca|jam[aá]s|ni|sin|tampoco|nadie|nada|ning[uú]n|ninguna|ninguno|ningunos|ningunas)\b/gu) || [];
const sameTokens = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Banded edit distance avoids allocating a text-length-squared matrix.
function editDistanceWithin(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let start = 0, aEnd = a.length, bEnd = b.length;
  while (start < aEnd && start < bEnd && a[start] === b[start]) start++;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) { aEnd--; bEnd--; }
  a = a.slice(start, aEnd); b = b.slice(start, bEnd);
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let previous = new Map(Array.from({ length: Math.min(b.length, limit) + 1 }, (_, i) => [i, i]));
  for (let i = 1; i <= a.length; i++) {
    const current = new Map();
    if (i <= limit) current.set(0, i);
    let minimum = limit + 1;
    for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++) {
      const value = Math.min((previous.get(j) ?? limit + 1) + 1, (current.get(j - 1) ?? limit + 1) + 1,
        (previous.get(j - 1) ?? limit + 1) + Number(a[i - 1] !== b[j - 1]));
      current.set(j, value); minimum = Math.min(minimum, value);
    }
    if (minimum > limit && !current.has(0)) return limit + 1;
    previous = current;
  }
  return previous.get(b.length) ?? limit + 1;
}

export function messageSimilarity(left, right) {
  const a = normalized(left), b = normalized(right);
  if (!a || !b) return { repeated: false, similarity: 0 };
  if (a === b) return { repeated: true, similarity: 1 };
  if (Math.min(a.length, b.length) < 20 || !sameTokens(numbers(a), numbers(b)) || !sameTokens(negations(a), negations(b))) return { repeated: false, similarity: 0 };
  const length = Math.max(a.length, b.length), limit = Math.floor(length * 0.1);
  const distance = editDistanceWithin(a, b, limit);
  return { repeated: distance <= limit, similarity: distance <= limit ? 1 - distance / length : null };
}

function repetition(messages, actor) {
  const sameActor = messages.filter(m => m.actor === actor);
  for (let i = 1; i < sameActor.length; i++) {
    const comparison = messageSimilarity(sameActor[i - 1].text, sameActor[i].text);
    if (comparison.repeated) return result(1, `Dos mensajes consecutivos del ${actor === 'bot' ? 'bot' : 'asistente humano'} coinciden${comparison.similarity === 1 ? ' tras normalizar espacios y mayúsculas' : ` con ${Math.round(comparison.similarity * 100)}% de similitud de edición`}.`,
      { evidence: evidence([sameActor[i - 1], sameActor[i]]), similarity: comparison.similarity, threshold: 0.9 });
  }
  return result(0, 'No hay mensajes consecutivos del mismo actor que cumplan la regla de repetición exacta o similar.');
}

const definitions = {
  min_primera_respuesta_humano: ['Código', 'Métrica', 'min'],
  min_silencio_max_humano: ['Código', 'Métrica', 'min'],
  min_duracion_conversacion: ['Código', 'Métrica', 'min'],
  num_mensajes_asistente: ['Código', 'Métrica', 'messages'],
  num_mensajes_cliente: ['Código', 'Métrica', 'messages'],
  ratio_mensajes_asistente_entre_cliente: ['Cálculo', 'Métrica', 'ratio'],
  num_mensajes_por_turno_asistente: ['Código', 'Métrica', 'messages_per_turn'],
  primera_respuesta_humano_mayor_5_min: ['Cálculo', 'Flag'],
  silencio_humano_mayor_10_min: ['Cálculo', 'Flag'],
  conversacion_mayor_120_min: ['Cálculo', 'Flag'],
  mas_mensajes_asistente_que_cliente: ['Cálculo', 'Flag'],
  varios_humanos_atendieron: ['Código', 'Flag'],
  bot_repitio_mensaje: ['Código', 'Flag'],
  humano_repitio_mensaje: ['Código', 'Flag'],
  botones_no_usados: ['Código', 'Descriptor'],
};

export function supportsCodeVariable(variable) {
  const definition = definitions[variable.id];
  return !!definition && definition[0] === variable.method && definition[1] === variable.type;
}

/** Memoized per conversation: dependencies need not be enabled as output. */
export function evaluateCodeVariables(conversation, variables) {
  const messages = (conversation.messages || []).filter(m => ['cliente', 'humano', 'bot'].includes(m.actor));
  const timestampsValid = messages.every(m => m.timestamp != null && m.timestamp !== '' && Number.isFinite(Date.parse(m.timestamp)));
  const ordered = timestampsValid ? messages.toSorted((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)) : messages;
  const counts = messageCounts(conversation.messages);
  const memo = new Map();
  const minutes = (a, b) => (Date.parse(b.timestamp) - Date.parse(a.timestamp)) / 60000;
  const validTime = fn => !ordered.length ? unavailable('No hay mensajes para calcular el tiempo.', 'NO_MESSAGES')
    : !timestampsValid ? unavailable('Hay mensajes sin una fecha válida; no se puede calcular el tiempo.', 'INVALID_TIMESTAMP') : fn();
  const dependent = (id, threshold, description) => {
    const metric = evaluate(id);
    if (metric.status !== 'evaluado') return unavailable(`No se puede determinar: ${metric.reason}`, 'DEPENDENCY_UNAVAILABLE', { dependencies: [id] });
    const value = Number(metric.value > threshold);
    return result(value, `${description}: ${metric.value} minutos; umbral estrictamente mayor a ${threshold} minutos.`, { dependencies: [id], inputs: { [id]: metric.value }, evidence: value ? metric.evidence : [] });
  };
  const rules = {
    num_mensajes_cliente: () => result(counts.cliente, 'Conteo de mensajes del cliente; se excluyen eventos técnicos y emisores no identificados.'),
    num_mensajes_asistente: () => result(counts.asistente, 'Conteo de mensajes del bot y de asistentes humanos; se excluyen eventos técnicos y emisores no identificados.'),
    min_primera_respuesta_humano: () => validTime(() => {
      const start = ordered.findIndex(m => m.actor === 'cliente');
      if (start < 0) return unavailable('No hay un mensaje del cliente que inicie la espera.', 'NO_CLIENT_MESSAGE');
      const response = ordered.slice(start + 1).find(m => m.actor === 'humano');
      if (!response) return unavailable('No intervino un humano después del primer mensaje del cliente.', 'NO_HUMAN_RESPONSE');
      return result(minutes(ordered[start], response), 'Tiempo transcurrido desde el primer mensaje del cliente hasta la primera respuesta humana, sin descontar horas fuera de atención.', { evidence: evidence([ordered[start], response]) });
    }),
    min_silencio_max_humano: () => validTime(() => {
      let pending = null, longest = null;
      for (const message of ordered) {
        if (message.actor === 'cliente' && !pending) pending = message;
        if (message.actor === 'humano' && pending) {
          const duration = minutes(pending, message);
          if (!longest || duration > longest.duration) longest = { duration, messages: [pending, message] };
          pending = null;
        }
      }
      if (pending) return unavailable('Existe una espera sin respuesta humana; el bot no termina ni reinicia esa espera.', 'UNRESOLVED_HUMAN_WAIT');
      if (!longest) return unavailable('No hay una espera del cliente con respuesta humana para calcular el silencio.', 'NO_HUMAN_WAIT');
      return result(longest.duration, 'Mayor intervalo entre el primer mensaje del cliente pendiente y la siguiente respuesta humana. El bot y los mensajes adicionales del cliente no reinician el tiempo.', { evidence: evidence(longest.messages) });
    }),
    min_duracion_conversacion: () => validTime(() => result(minutes(ordered[0], ordered.at(-1)), 'Tiempo entre el primer y último mensaje del contenido evaluado; no se divide en atenciones.', { evidence: evidence(ordered.length === 1 ? [ordered[0]] : [ordered[0], ordered.at(-1)]) })),
    ratio_mensajes_asistente_entre_cliente: () => {
      const client = evaluate('num_mensajes_cliente').value, agent = evaluate('num_mensajes_asistente').value;
      if (!client) return unavailable('No hay mensajes del cliente; no se puede dividir entre cero.', 'ZERO_DENOMINATOR');
      return result(agent / client, 'Mensajes de bot y humanos divididos entre mensajes del cliente.', { inputs: { num_mensajes_asistente: agent, num_mensajes_cliente: client } });
    },
    num_mensajes_por_turno_asistente: () => {
      let turns = 0, inAssistantTurn = false;
      for (const message of ordered) {
        if (assistant(message)) { if (!inAssistantTurn) turns++; inAssistantTurn = true; }
        else if (message.actor === 'cliente') inAssistantTurn = false;
      }
      if (!turns) return unavailable('No hay turnos del asistente para calcular el promedio.', 'NO_ASSISTANT_TURNS');
      return result(evaluate('num_mensajes_asistente').value / turns, 'Promedio de mensajes del bot y humanos por serie consecutiva sin intervención del cliente.', { turns });
    },
    primera_respuesta_humano_mayor_5_min: () => unavailable('Pendiente de configurar el horario de atención por país; se conserva la métrica de tiempo transcurrido.', 'BUSINESS_HOURS_NOT_CONFIGURED'),
    silencio_humano_mayor_10_min: () => dependent('min_silencio_max_humano', 10, 'Mayor silencio humano'),
    conversacion_mayor_120_min: () => dependent('min_duracion_conversacion', 120, 'Duración de la conversación'),
    mas_mensajes_asistente_que_cliente: () => {
      const agent = evaluate('num_mensajes_asistente').value, client = evaluate('num_mensajes_cliente').value;
      return result(Number(agent > client), `El asistente envió ${agent} mensajes y el cliente ${client}; cualquier exceso activa el flag.`, { inputs: { num_mensajes_asistente: agent, num_mensajes_cliente: client } });
    },
    varios_humanos_atendieron: () => {
      const human = messages.filter(m => m.actor === 'humano');
      if (!conversation.messageAgentIdsAvailable || human.some(m => m.agentId == null || m.agentId === '')) return unavailable('Falta la identidad del asesor en cada mensaje de Atom; no se infiere a partir del asesor actual.', 'MESSAGE_AGENT_IDS_UNAVAILABLE');
      const ids = new Set(human.map(m => String(m.agentId)));
      const representatives = [...new Map(human.map(m => [String(m.agentId), m])).values()];
      return result(Number(ids.size > 1), `Intervinieron ${ids.size} asistentes humanos identificados por sus mensajes.`, { evidence: ids.size > 1 ? evidence(representatives.slice(0, 3)) : [] });
    },
    bot_repitio_mensaje: () => repetition(ordered, 'bot'),
    humano_repitio_mensaje: () => repetition(ordered, 'humano'),
    botones_no_usados: () => {
      if (!conversation.buttonEventsAvailable || !Array.isArray(conversation.offeredButtons) || !Array.isArray(conversation.selectedButtonIds)) return unavailable('Faltan los botones ofrecidos y seleccionados en los eventos de Atom.', 'BUTTON_EVENTS_UNAVAILABLE');
      if (conversation.offeredButtons.some(b => !b || typeof b.id !== 'string' || typeof b.label !== 'string')) return unavailable('Los botones no tienen identidad y etiqueta válidas.', 'INVALID_BUTTON_EVENTS');
      const selected = new Set(conversation.selectedButtonIds);
      const values = [...new Map(conversation.offeredButtons.filter(b => !selected.has(b.id)).map(b => [b.id, b.label])).values()];
      return result(values, 'Botones ofrecidos cuyo identificador no fue seleccionado por el cliente.');
    },
  };
  function evaluate(id) {
    if (!memo.has(id)) {
      const [method, , unit] = definitions[id];
      memo.set(id, { variableId: id, method, ...rules[id](), ...(unit ? { unit } : {}), codeRule: `${CODE_RULES_VERSION}:${id}` });
    }
    return memo.get(id);
  }
  return variables.map(variable => {
    if (!supportsCodeVariable(variable)) throw new AppError(422, `La variable ${variable.id} aún no tiene una regla de código implementada.`, 'UNSUPPORTED_VARIABLE');
    return structuredClone(evaluate(variable.id));
  });
}

export function evaluateCodeVariable(conversation, variable) {
  return evaluateCodeVariables(conversation, [variable])[0];
}
