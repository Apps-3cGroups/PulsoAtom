import { readFileSync } from 'node:fs';

export const initialCatalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
export const countries = [
  { code: 'MX', name: 'México', agents: ['Karla Méndez', 'Jorge Salinas', 'Daniela Ruiz'] },
  { code: 'GT', name: 'Guatemala', agents: ['Ana Lucía Pérez', 'Kevin Monzón', 'Gabriela Ixcot'] },
  { code: 'SV', name: 'El Salvador', agents: ['Marcela Rivas', 'Josué Hernández', 'Karen Alvarado'] },
  { code: 'HN', name: 'Honduras', agents: ['Dania Zelaya', 'Allan Banegas', 'Wendy Matute'] },
  { code: 'NI', name: 'Nicaragua', agents: ['Yader Rocha', 'Scarleth Obando', 'Hazel Membreño'] },
  { code: 'CR', name: 'Costa Rica', agents: ['Valeria Solano', 'Andrés Quesada', 'María José Vargas'] },
];
const situations = [
  { flags: ['cliente_amenazo_cancelar', 'cliente_molesto'], text: 'Si no me confirman la entrega, voy a cancelar. Estoy muy molesta con la demora.', actor: 'cliente', topic: 'Entrega a domicilio' },
  { flags: ['cliente_pidio_supervisor', 'asistente_genero_friccion'], text: 'Ya se lo expliqué. No voy a repetir el procedimiento.', actor: 'humano', extra: 'Quiero hablar con un supervisor, por favor.', topic: 'Seguimiento de pedido' },
  { flags: ['asistente_dio_consejo_medico'], text: 'Yo te recomiendo cambiar el tratamiento por otro medicamento.', actor: 'humano', topic: 'Consulta de productos' },
  { flags: ['cliente_cancelo_pedido'], text: 'Por favor cancela mi pedido, ya no lo necesito.', actor: 'cliente', topic: 'Cancelación de pedido' },
  { flags: ['sentimiento_cliente_empeoro'], text: 'Al principio estaba tranquila, pero con tantas vueltas ahora estoy muy frustrada.', actor: 'cliente', topic: 'Disponibilidad' },
  { flags: ['asistente_no_respondio_ultimo_mensaje'], text: '¿Me puedes confirmar cuándo llegará mi pedido?', actor: 'cliente', topic: 'Entrega a domicilio' },
];
export function createState(demo = true) {
  const createdAt = '2026-10-26T14:00:00.000Z';
  const catalog = structuredClone(initialCatalog);
  const state = {
    schemaVersion: 1, catalog,
    catalogVersions: catalog.map(item => ({ id: `${item.id}:1`, itemId: item.id, version: 1, snapshot: structuredClone(item), actor: 'Importación inicial del Excel', createdAt })),
    catalogAudit: [], users: [], sessions: [], conversations: [], evaluations: [], reviews: [], jobs: [],
    operationalRefs: [], comparisons: [], tasks: [], attempts: [], verdicts: [], exposures: [], validations: [],
    settings: { dailyEnabled: false, dailyTime: '07:00', timezone: 'America/Tegucigalpa', version: 1 },
    metadata: { demo, lastLoadedAt: demo ? createdAt : null, source: demo ? 'Datos de demostración' : 'Atom pendiente de conexión' },
  };
  if (!demo) return state;
  state.users = [
    { id: 'demo-admin', name: 'Administración demo', email: 'admin@demo.pulso', role: 'admin', active: true },
    { id: 'demo-supervisor', name: 'Supervisión demo', email: 'supervisor@demo.pulso', role: 'supervisor', active: true },
  ];
  let index = 0;
  for (const country of countries) for (let agentIndex = 0; agentIndex < 3; agentIndex++) for (let day = 0; day < 4; day++) for (let slot = 0; slot < 3; slot++) {
    index++;
    const date = `2026-10-${25 - day}`;
    const hour = String(9 + slot * 3 + agentIndex).padStart(2, '0');
    const startedAt = `${date}T${hour}:12:00-06:00`;
    const endedAt = `${date}T${hour}:28:00-06:00`;
    const flagged = index % 5 === 0 || index === 1;
    const situation = situations[Math.floor(index / 5) % situations.length];
    const id = `DEMO-${country.code}-${String(index).padStart(4, '0')}`;
    const names = ['Laura', 'Roberto', 'María', 'José', 'Ana', 'Luis', 'Sofía', 'Diego'];
    const topic = flagged ? situation.topic : ['Consulta de disponibilidad', 'Seguimiento de pedido', 'Información de sucursal'][slot];
    const messages = [
      { id: `${id}-m1`, actor: 'cliente', text: `Hola, necesito ayuda con ${topic.toLowerCase()}.`, timestamp: startedAt },
      { id: `${id}-m2`, actor: 'bot', text: 'Hola. Te comunicaré con un asistente de venta.', timestamp: `${date}T${hour}:13:00-06:00` },
      { id: `${id}-m3`, actor: 'humano', text: 'Hola, con gusto te ayudo. Estoy revisando la información.', timestamp: `${date}T${hour}:15:00-06:00` },
      { id: `${id}-m4`, actor: flagged ? situation.actor : 'cliente', text: flagged ? situation.text : 'Gracias, quedo pendiente de la confirmación.', timestamp: `${date}T${hour}:22:00-06:00` },
    ];
    if (flagged && situation.extra) messages.push({ id: `${id}-m5`, actor: 'cliente', text: situation.extra, timestamp: `${date}T${hour}:25:00-06:00` });
    if (!(flagged && situation.flags.includes('asistente_no_respondio_ultimo_mensaje'))) messages.push({ id: `${id}-m6`, actor: 'humano', text: 'He registrado tu solicitud para darle seguimiento. Gracias por contactarnos.', timestamp: endedAt });
    const evaluated = index % 17 !== 0;
    state.conversations.push({
      id, sourceId: id, demo: true, country: country.code, countryName: country.name,
      agent: { id: `${country.code}-${agentIndex + 1}`, name: country.agents[agentIndex] },
      client: { name: names[index % names.length], code: `DEMO-C${1000 + index}`, phoneLast4: String(4000 + index) },
      date, startedAt, endedAt, channel: ['WhatsApp', 'Webchat', 'Facebook'][index % 3],
      topics: [topic], media: index % 4 === 0 ? ['imagen'] : index % 13 === 0 ? ['audio'] : [],
      messages, sourceUrl: null, evaluationId: evaluated ? `eval-${id}` : null,
    });
    if (evaluated) state.evaluations.push({
      id: `eval-${id}`, conversationId: id, createdAt, demo: true,
      catalogVersions: catalog.map(v => ({ id: v.id, version: 1, active: v.active })),
      results: catalog.filter(v => v.active).map(v => {
        const value = flagged && situation.flags.includes(v.id) ? 1 : 0;
        const evidenceMessage = v.id === 'cliente_pidio_supervisor' ? messages.find(m => m.id.endsWith('-m5')) : messages[3];
        return { variableId: v.id, status: 'evaluado', value, evidence: value ? [{ messageId: evidenceMessage.id, quote: evidenceMessage.text }] : [], reason: value ? 'Caso sintético creado para demostrar la revisión de este evento.' : null };
      }),
    });
    if (evaluated && flagged && index % 15 === 0) state.reviews.push({ id: `ref-${id}`, conversationId: id, evaluationId: `eval-${id}`, variableId: situation.flags[0], action: 'refutar', reason: 'falta_contexto', comment: 'Ejemplo de refutación: la frase se refería a una solicitud anterior.', authorId: 'demo-supervisor', authorName: 'Supervisión demo', createdAt });
    if (evaluated && !flagged && index % 11 === 0) state.reviews.push({ id: `human-${id}`, conversationId: id, evaluationId: `eval-${id}`, variableId: 'asistente_no_respondio_ultimo_mensaje', action: 'levantar', reason: 'omision_del_modelo', comment: 'Ejemplo de flag humano: la respuesta no confirma la información solicitada.', evidence: { messageId: messages[0].id, quote: messages[0].text }, authorId: 'demo-supervisor', authorName: 'Supervisión demo', createdAt });
  }
  return state;
}
