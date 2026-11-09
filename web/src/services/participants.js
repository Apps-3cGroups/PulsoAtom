export const actorName = actor => ({
  cliente: 'Cliente', bot: 'Bot', humano: 'Agente humano',
  sistema: 'Evento técnico', desconocido: 'Emisor no identificado',
}[actor] || 'Emisor no identificado');
