import { catalogReferences, evaluationContext } from '../evaluation-context.js';
import { evaluateCodeVariables, supportsCodeVariable } from '../code-evaluator.js';

/** Explicit synthetic UI fixtures. No provider, database or source-system calls. */
export function addV5Demo(state) {
  if (!state.metadata?.demo) throw new Error('Los ejemplos v5 solo pueden añadirse al modo demostración.');
  if (state.jobs.some(job => job.id === 'demo-v5-dual')) return state;
  const createdAt = '2026-10-25T22:00:00.000Z';
  const profiles = [
    { id: 'demo-openai-v5', label: 'GPT · demostración', provider: 'openai', model: 'demo-gpt', enabled: true },
    { id: 'demo-gemini-v5', label: 'Gemini · demostración', provider: 'gemini', model: 'demo-gemini', enabled: true },
  ];
  const active = state.catalog.filter(v => v.active && !v.retired);
  const catalogVersions = catalogReferences(state.catalog);
  const definitions = [
    { id: 'DEMO-V5-01', country: 'HN', countryName: 'Honduras', client: 'Lucía · caso sintético', agent: 'Dania Zelaya',
      messages: [['cliente', 0, 'Estoy molesta, llevo esperando y necesito ayuda con mi pedido.'], ['bot', 1, 'Te comunicaré con una persona.'],
        ['humano', 12, 'Hola, Lucía. Revisé tu pedido y ya confirmé la entrega.'], ['cliente', 14, 'Muchas gracias, hiciste un excelente trabajo.'], ['humano', 15, 'Gracias por tu reconocimiento, estamos para ayudarte.']],
      flags: ['cliente_molesto', 'cliente_felicito_al_asistente', 'sentimiento_cliente_mejoro'] },
    { id: 'DEMO-V5-02', country: 'HN', countryName: 'Honduras', client: 'Carlos · caso sintético', agent: 'Allan Banegas',
      messages: [['cliente', 0, 'Quisiera consultar por una entrega.'], ['humano', 2, 'Hola, con gusto te ayudo.'], ['cliente', 3, 'Si no puedes confirmarlo, prefiero hablar con un supervisor.'], ['humano', 4, 'Te comunicaré con supervisión.']],
      flags: ['cliente_pidio_supervisor'], discrepancy: 'cliente_pidio_supervisor' },
    { id: 'DEMO-V5-03', country: 'SV', countryName: 'El Salvador', client: 'Andrea · caso sintético', agent: 'Marcela Rivas',
      messages: [['cliente', 0, 'Quiero agradecer por la ayuda. En mi pedido anterior estaba molesta, hoy todo salió bien.'], ['humano', 3, 'Gracias por comentarlo, Andrea.'], ['cliente', 4, 'Excelente trabajo, muchas gracias.'], ['humano', 5, 'Gracias por tu reconocimiento.']],
      flags: ['cliente_molesto'], refute: 'cliente_molesto', human: 'cliente_felicito_al_asistente' },
    { id: 'DEMO-V5-04', country: 'CR', countryName: 'Costa Rica', client: 'Diego · caso sintético', agent: 'Valeria Solano',
      messages: [['cliente', 0, 'Necesito consultar disponibilidad.'], ['bot', 1, 'Estamos buscando un asistente.'], ['cliente', 8, '¿Me puede atender alguien?']],
      flags: [], failedGemini: true },
  ];
  const job = { id: 'demo-v5-dual', purpose: 'operational', mode: 'dual', scope: 'recheck', status: 'partial', caseCount: definitions.length,
    total: definitions.length * 2, completed: definitions.length * 2 - 1, failed: 1, modelProfiles: profiles, catalogVersions,
    conversationIds: definitions.map(d => d.id), demo: true, createdAt, updatedAt: createdAt, finishedAt: createdAt, errors: [] };
  state.jobs.push(job);
  for (const item of definitions) {
    const messages = item.messages.map(([actor, minute, text], i) => ({ id: `${item.id}-m${i + 1}`, actor, text,
      timestamp: new Date(Date.UTC(2026, 9, 25, 18, minute)).toISOString() }));
    const conversation = { id: item.id, sourceId: item.id, demo: true, completed: !item.failedGemini,
      country: item.country, countryName: item.countryName, agent: { id: `demo-v5-agent-${item.id}`, name: item.agent },
      client: { name: item.client, code: item.id, phoneLast4: null }, date: '2026-10-25', startedAt: messages[0].timestamp,
      endedAt: messages.at(-1).timestamp, channel: 'Demostración v5', topics: ['Datos sintéticos · no evaluados por IA real'], media: [], messages, sourceUrl: null };
    const context = evaluationContext(conversation, state.catalog);
    const codeResults = evaluateCodeVariables(conversation, active.filter(supportsCodeVariable));
    for (const [i, profile] of profiles.entries()) {
      const taskId = `${item.id}-task-${i}`, evaluationId = `${item.id}-eval-${i}`;
      const failed = item.failedGemini && i === 1;
      const task = { id: taskId, jobId: job.id, conversationId: item.id, profile, context, codeResults: structuredClone(codeResults),
        status: failed ? 'failed' : 'completed', round: 1, demo: true, evaluationId: failed ? null : evaluationId,
        error: failed ? { code: 'AI_UNAVAILABLE', message: 'Fallo simulado para demostrar una revisión pendiente.' } : null };
      state.tasks.push(task);
      if (failed) continue;
      const aiResults = active.filter(v => !supportsCodeVariable(v)).map(v => {
        let value = v.type === 'Descriptor' ? v.id === 'tipo_interaccion' ? 'seguimiento de entrega' : [] : Number(item.flags.includes(v.id) && !(i === 1 && item.discrepancy === v.id));
        const message = v.mark === '+' ? messages.find(m => m.text.includes('excelente')) || messages.at(-1) : messages.find(m => m.text.includes('supervisor') || m.text.includes('molesta')) || messages[0];
        return { variableId: v.id, method: v.method, status: 'evaluado', value,
          reason: 'Resultado sintético preparado exclusivamente para revisar la interfaz; no proviene de una llamada a IA.',
          evidence: value === 1 ? [{ messageId: message.id, quote: message.text }] : [] };
      });
      state.evaluations.push({ id: evaluationId, jobId: job.id, taskId, conversationId: item.id, purpose: 'operational', demo: true,
        createdAt, ...context, catalogVersions, profileId: profile.id, profileLabel: profile.label, provider: profile.provider, model: profile.model,
        results: [...aiResults, ...structuredClone(codeResults)] });
      if (i === 0) {
        conversation.evaluationId = evaluationId;
        state.operationalRefs.push({ id: item.id, evaluationId });
        for (const [action, variableId] of [['refutar', item.refute], ['levantar', item.human]]) if (variableId) {
          state.reviews.push({ id: `${item.id}-${action}`, conversationId: item.id, evaluationId, variableId, action,
            reason: action === 'refutar' ? 'falta_contexto' : 'omision_del_modelo', comment: action === 'refutar'
              ? 'Ejemplo sintético: la molestia se refiere a una atención anterior.' : 'Ejemplo sintético: el cliente reconoció expresamente la atención.',
            evidence: action === 'levantar' ? { messageId: messages[2].id, quote: messages[2].text } : null,
            authorId: 'demo-supervisor', authorName: 'Supervisión demo', createdAt });
        }
      }
    }
    state.conversations.push(conversation);
  }
  return state;
}
