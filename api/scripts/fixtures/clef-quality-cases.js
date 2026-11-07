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
      message('cordial-c1', 'cliente', 'Hola, ¿tienen disponible el producto que consulté?', 0),
      message('cordial-a1', 'humano', 'Hola. Sí, está disponible. Con gusto le ayudo.', 1),
      message('cordial-c2', 'cliente', '¡Muchísimas gracias, de verdad me ayudó muchísimo!', 2),
      message('cordial-a2', 'humano', 'Con gusto. Que tenga un buen día.', 3),
    ],
    expected: expected(0, 0),
  },
  {
    id: 'synthetic-customer-anger',
    messages: [
      message('anger-c1', 'cliente', 'Estoy muy molesto con la atención. Esta demora me tiene frustrado.', 0),
      message('anger-a1', 'humano', 'Lamento la demora. Revisaré el estado de su solicitud.', 1),
    ],
    expected: expected(1, 0, ['anger-c1']),
  },
  {
    id: 'synthetic-assistant-disrespect',
    messages: [
      message('disrespect-c1', 'cliente', 'Hola, ¿puede confirmar la disponibilidad, por favor?', 0),
      message('disrespect-a1', 'humano', 'Qué pregunta tan tonta. Aprenda a leer antes de molestar.', 1),
    ],
    expected: expected(0, 1, [], ['disrespect-a1']),
  },
  {
    id: 'synthetic-both-positive',
    messages: [
      message('both-c1', 'cliente', 'Estoy muy molesto con el servicio. Me frustra que no atiendan mi solicitud.', 0),
      message('both-a1', 'humano', 'Usted es un cliente idiota. Deje de molestar con sus preguntas.', 1),
    ],
    expected: expected(1, 1, ['both-c1'], ['both-a1']),
  },
  {
    id: 'synthetic-customer-insult-actor-control',
    messages: [
      message('actor-c1', 'cliente', 'Estoy muy molesto. Usted es un incompetente y su servicio es pésimo.', 0),
      message('actor-a1', 'humano', 'Lamento que esté molesto. Con gusto revisaré su solicitud para ayudarle.', 1),
    ],
    expected: expected(1, 0, ['actor-c1']),
  },
  {
    id: 'synthetic-missing-customer-content',
    messages: [
      // Exact placeholder produced by mapAtomConversation for an untranscribed
      // call. evaluationInput sends this text and actor, not media metadata.
      message('missing-c1', 'cliente', '[llamada]', 0),
      message('missing-a1', 'humano', 'Gracias por comunicarse. Con gusto le ayudaré.', 1),
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
