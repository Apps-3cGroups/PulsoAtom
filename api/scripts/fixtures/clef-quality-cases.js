// Hand-authored synthetic controls. Never send `expected` to the evaluator;
// construct its conversation from only id/messages/completed.
export const selectedVariableIds = ['cliente_molesto', 'asistente_falto_al_respeto'];
const decision = (value, evidenceIds = []) => ({ status: value === null ? 'no_evaluado' : 'evaluado', value, evidenceIds });
const expected = (clientValue, respectValue, clientEvidence = [], respectEvidence = []) => ({
  cliente_molesto: decision(clientValue, clientEvidence),
  asistente_falto_al_respeto: decision(respectValue, respectEvidence),
});
const message = (id, actor, text, minute) => ({ id, actor, text, timestamp: `2026-11-07T12:${String(minute).padStart(2, '0')}:00.000Z` });

export const qualityCases = [
  {
    id: 'synthetic-cordial',
    messages: [
      message('m1', 'cliente', 'Hola, ¿tienen disponible el producto que consulté?', 0),
      message('m2', 'humano', 'Hola. Sí, está disponible. Con gusto le ayudo.', 1),
      message('m3', 'cliente', '¡Muchísimas gracias, de verdad me ayudó muchísimo!', 2),
      message('m4', 'humano', 'Con gusto. Que tenga un buen día.', 3),
    ],
    expected: expected(0, 0),
  },
  {
    id: 'synthetic-customer-anger',
    messages: [
      message('m1', 'cliente', 'Estoy muy molesto con la atención. Esta demora me tiene frustrado.', 0),
      message('m2', 'humano', 'Lamento la demora. Revisaré el estado de su solicitud.', 1),
    ],
    expected: expected(1, 0, ['m1']),
  },
  {
    id: 'synthetic-assistant-disrespect',
    messages: [
      message('m1', 'cliente', 'Hola, ¿puede confirmar la disponibilidad, por favor?', 0),
      message('m2', 'humano', 'Qué pregunta tan tonta. Aprenda a leer antes de molestar.', 1),
    ],
    expected: expected(0, 1, [], ['m2']),
  },
  {
    id: 'synthetic-both-positive',
    messages: [
      message('m1', 'cliente', 'Estoy muy molesto con el servicio. Me frustra que no atiendan mi solicitud.', 0),
      message('m2', 'humano', 'Usted es un cliente idiota. Deje de molestar con sus preguntas.', 1),
    ],
    expected: expected(1, 1, ['m1'], ['m2']),
  },
  {
    id: 'synthetic-customer-insult-actor-control',
    messages: [
      message('m1', 'cliente', 'Estoy muy molesto. Usted es un incompetente y su servicio es pésimo.', 0),
      message('m2', 'humano', 'Lamento que esté molesto. Con gusto revisaré su solicitud para ayudarle.', 1),
    ],
    expected: expected(1, 0, ['m1']),
  },
  {
    id: 'synthetic-missing-customer-content',
    messages: [
      // Exact placeholder produced by mapAtomConversation for an untranscribed
      // call. evaluationInput sends this text and actor, not media metadata.
      message('m1', 'cliente', '[llamada]', 0),
      message('m2', 'humano', 'Gracias por comunicarse. Con gusto le ayudaré.', 1),
    ],
    expected: expected(null, 0),
  },
];

// The same visible conversation and target answers with the larger checklist
// distinguish task-size degradation from failure on a simple positive control.
export const fullChecklistCase = {
  id: 'synthetic-full-checklist-both-positive',
  messages: qualityCases[3].messages.map(item => ({ ...item })),
  expected: Object.fromEntries(Object.entries(qualityCases[3].expected).map(([id, item]) => [id, { ...item, evidenceIds: [...item.evidenceIds] }])),
};
