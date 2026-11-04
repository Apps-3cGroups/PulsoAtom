import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogV5 } from '../src/catalog-v5.js';
import { evaluateCodeVariable, evaluateCodeVariables, messageSimilarity, supportsCodeVariable, CODE_RULES_VERSION } from '../src/code-evaluator.js';

const variable = id => catalogV5.find(v => v.id === id);
const message = (id, actor, minute, text = 'Texto de prueba') => ({ id, actor, text, timestamp: new Date(Date.UTC(2026, 10, 3, 12, minute)).toISOString() });
const evaluate = (id, messages, extra = {}) => evaluateCodeVariable({ messages, ...extra }, variable(id));

test('all fifteen deterministic phase-one variables are supported and typed', () => {
  const variables = catalogV5.filter(v => v.phase === 1 && ['Código', 'Cálculo'].includes(v.method));
  assert.equal(variables.length, 15);
  assert.ok(variables.every(supportsCodeVariable));
  const results = evaluateCodeVariables({ messages: [message('a', 'cliente', 0), message('b', 'humano', 5)] }, variables);
  assert.equal(results.length, 15);
  assert.ok(results.every(r => r.codeRule.startsWith(CODE_RULES_VERSION) && r.method));
  assert.equal(results.find(r => r.variableId === 'ratio_mensajes_asistente_entre_cliente').unit, 'ratio');
});

test('bot and repeated client messages neither reset nor complete the human waiting interval', () => {
  const messages = [message('a', 'cliente', 0), message('b', 'bot', 1), message('c', 'cliente', 4), message('d', 'humano', 11),
    message('e', 'cliente', 14), message('f', 'bot', 15), message('g', 'humano', 19)];
  assert.equal(evaluate('min_primera_respuesta_humano', messages).value, 11);
  const silence = evaluate('min_silencio_max_humano', messages);
  assert.equal(silence.value, 11);
  assert.deepEqual(silence.evidence.map(e => e.messageId), ['a', 'd']);
  assert.equal(evaluate('silencio_humano_mayor_10_min', messages).value, 1);
  assert.equal(evaluate('min_silencio_max_humano', [...messages, message('h', 'cliente', 20)]).unavailableReason, 'UNRESOLVED_HUMAN_WAIT');
});

test('strict thresholds and dependent metrics work even when metric output is inactive', () => {
  assert.equal(evaluate('silencio_humano_mayor_10_min', [message('a', 'cliente', 0), message('b', 'humano', 10)]).value, 0);
  const messages = [message('a', 'cliente', 0), message('b', 'humano', 120)];
  assert.equal(evaluate('conversacion_mayor_120_min', messages).value, 0);
  const results = evaluateCodeVariables({ messages: [...messages, message('c', 'humano', 121)] }, [variable('conversacion_mayor_120_min')]);
  assert.equal(results.length, 1); assert.equal(results[0].value, 1);
  assert.equal(evaluate('primera_respuesta_humano_mayor_5_min', messages).unavailableReason, 'BUSINESS_HOURS_NOT_CONFIGURED');
});

test('message counts, ratio and assistant turns exclude system events', () => {
  const messages = [message('a', 'cliente', 0), message('b', 'bot', 1), message('c', 'sistema', 2), message('d', 'humano', 3),
    message('e', 'cliente', 4), message('f', 'humano', 5)];
  assert.equal(evaluate('num_mensajes_asistente', messages).value, 3);
  assert.equal(evaluate('num_mensajes_cliente', messages).value, 2);
  assert.equal(evaluate('ratio_mensajes_asistente_entre_cliente', messages).value, 1.5);
  assert.equal(evaluate('num_mensajes_por_turno_asistente', messages).value, 1.5);
  assert.equal(evaluate('mas_mensajes_asistente_que_cliente', messages).value, 1);
  assert.equal(evaluate('min_duracion_conversacion', [...messages, message('system', 'sistema', 180)]).value, 5);
});

test('missing timestamps, absent human, missing turns and division by zero are unavailable, not zero', () => {
  assert.equal(evaluate('min_duracion_conversacion', [{ id: 'a', actor: 'cliente', timestamp: 'invalid' }]).unavailableReason, 'INVALID_TIMESTAMP');
  assert.equal(evaluate('min_duracion_conversacion', [{ id: 'a', actor: 'cliente', timestamp: null }]).unavailableReason, 'INVALID_TIMESTAMP');
  const messages = [message('a', 'cliente', 0), message('b', 'bot', 1)];
  assert.equal(evaluate('min_primera_respuesta_humano', messages).unavailableReason, 'NO_HUMAN_RESPONSE');
  assert.equal(evaluate('min_silencio_max_humano', messages).value, null);
  assert.equal(evaluate('ratio_mensajes_asistente_entre_cliente', [message('b', 'bot', 1)]).unavailableReason, 'ZERO_DENOMINATOR');
  assert.equal(evaluate('num_mensajes_por_turno_asistente', [message('a', 'cliente', 0)]).unavailableReason, 'NO_ASSISTANT_TURNS');
  assert.equal(evaluate('min_duracion_conversacion', []).value, null);
});

test('repetition detects normalized exact or near-identical messages with guardrails', () => {
  assert.equal(messageSimilarity(' HOLA   Cliente ', 'hola cliente').repeated, true);
  assert.equal(messageSimilarity('Hola', 'Holo').repeated, false);
  assert.equal(messageSimilarity('Hola, estamos revisando su solicitud.', 'Hola, estamos revisando tu solicitud.').repeated, true);
  assert.equal(messageSimilarity('Su pedido está disponible para retirar hoy.', 'Su pedido no está disponible para retirar hoy.').repeated, false);
  assert.equal(messageSimilarity('El total de su pedido es de 100 lempiras.', 'El total de su pedido es de 101 lempiras.').repeated, false);
  const messages = [message('a', 'bot', 0, 'Hola, estamos revisando su solicitud.'), message('b', 'cliente', 1), message('c', 'bot', 2, 'Hola, estamos revisando tu solicitud.')];
  const r = evaluate('bot_repitio_mensaje', messages);
  assert.equal(r.value, 1); assert.deepEqual(r.evidence.map(e => e.messageId), ['a', 'c']);
  assert.equal(evaluate('humano_repitio_mensaje', messages).value, 0);
});

test('identity and button rules remain pending without explicit source metadata', () => {
  const messages = [message('a', 'humano', 0), message('b', 'humano', 1)];
  assert.equal(evaluate('varios_humanos_atendieron', messages, { agent: { id: 'current-agent' } }).unavailableReason, 'MESSAGE_AGENT_IDS_UNAVAILABLE');
  assert.equal(evaluate('botones_no_usados', messages).unavailableReason, 'BUTTON_EVENTS_UNAVAILABLE');
  assert.equal(evaluate('varios_humanos_atendieron', messages.map((m, i) => ({ ...m, agentId: String(i) })), { messageAgentIdsAvailable: true }).value, 1);
  assert.deepEqual(evaluate('botones_no_usados', messages, { buttonEventsAvailable: true, offeredButtons: [{ id: '1', label: 'Comprar' }, { id: '2', label: 'Consultar' }], selectedButtonIds: ['1'] }).value, ['Consultar']);
});
