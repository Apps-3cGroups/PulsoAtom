import assert from 'node:assert/strict';
import test from 'node:test';
import { atomAgentNameIndex, atomMessageActor, mapAtomConversation } from '../src/atom.js';
import { messageCounts } from '../src/message-counts.js';
import { evaluateCodeVariables } from '../src/code-evaluator.js';
import { sourceFingerprint } from '../src/evaluation-context.js';
import { actorName } from '../../web/src/services/participants.js';

const catalog = atomAgentNameIndex([{ Nombre: 'Asesora Anterior' }, { Nombre: 'Ana  Pérez ' }, { Nombre: null }, { Nombre: ' ' }]);
const row = { IdConversacion: 1, AsesorNombre: 'Asesor actual', ClienteNombre: 'Cliente', FechaInicioUtc: '2026-11-17T13:00:00Z' };

test('un emisor del catálogo se reconoce aunque el export solo conserve el nombre y cambie el asesor actual', () => {
  const event = { IdEvento: 1, TipoOrigen: 'text', RolEmisor: null, DeOrigen: 'Asesora  Anterior ', IdAsesor: null,
    Direccion: null, Texto: 'Respuesta de prueba', FechaHoraUtc: '2026-11-17T13:30:00Z' };
  const before = mapAtomConversation(row, [event], { code: 'MX' }, 'America/Tegucigalpa');
  const after = mapAtomConversation(row, [event], { code: 'MX' }, 'America/Tegucigalpa', catalog);
  assert.equal(before.messages[0].actor, 'desconocido');
  assert.equal(after.messages[0].actor, 'humano');
  assert.equal(actorName(after.messages[0].actor), 'Agente humano');
  assert.equal(after.agent.name, 'Asesor actual');
  assert.equal(after.messages[0].text, event.Texto);
  assert.equal(messageCounts(after.messages).humano, 1);
  const [metric] = evaluateCodeVariables(after, [{ id: 'num_mensajes_asistente', type: 'Métrica', method: 'Código' }]);
  assert.equal(metric.value, 1);
  assert.notEqual(sourceFingerprint(before), sourceFingerprint(after));
});

test('los nombres toleran espacios, acentos y mayúsculas sin hacer coincidencias parciales', () => {
  for (const DeOrigen of ['ANA PEREZ', ' Ana\tPérez ', 'Ana\u00a0  Pérez']) {
    assert.equal(atomMessageActor({ DeOrigen }, row, catalog), 'humano');
  }
  for (const DeOrigen of ['', null, 'Ana', 'Ana Pérez Otra', 'Nombre desconocido']) {
    assert.equal(atomMessageActor({ DeOrigen, Direccion: 'SALIENTE' }, row, catalog), 'desconocido');
  }
});

test('el catálogo no cambia clientes, bots ni eventos técnicos explícitos', () => {
  const names = atomAgentNameIndex(['Cliente', 'ATOM', 'API', 'Fahorro_Cortex', 'Flujo ventas', 'Asesora Anterior'].map(Nombre => ({ Nombre })));
  const cases = [
    [{ DeOrigen: 'Cliente' }, 'cliente'],
    [{ DeOrigen: 'Asesora Anterior', Direccion: 'ENTRANTE' }, 'cliente'],
    [{ DeOrigen: 'Asesora Anterior', RolEmisor: 'CLIENTE' }, 'cliente'],
    [{ DeOrigen: 'Asesora Anterior', RolEmisor: 'BOT' }, 'bot'],
    [{ DeOrigen: 'Asesora Anterior', TipoOrigen: 'log' }, 'sistema'],
    ...['ATOM', 'API', 'Fahorro_Cortex', 'Flujo ventas'].map(DeOrigen => [{ DeOrigen }, 'bot']),
  ];
  for (const [event, actor] of cases) assert.equal(atomMessageActor(event, row, names), actor);
  assert.equal(atomMessageActor({ DeOrigen: 'Asesora  Anterior' }, { ClienteNombre: 'Asesora Anterior' }, names), 'desconocido');
});
