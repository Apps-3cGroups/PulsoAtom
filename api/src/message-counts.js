export function messageCounts(messages = []) {
  const counts = { cliente: 0, bot: 0, humano: 0, sistema: 0, desconocido: 0 };
  for (const message of messages) counts[Object.hasOwn(counts, message.actor) ? message.actor : 'desconocido']++;
  return { ...counts, asistente: counts.bot + counts.humano, total: messages.length };
}
