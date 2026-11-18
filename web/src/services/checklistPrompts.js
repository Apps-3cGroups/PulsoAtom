// Fits the complete catalog criterion plus a previously saved 12,000-character addition.
export const itemPromptMaxLength = 24000;
const models = ['clef-local', 'gemma-local'];

export function catalogItemPrompt(item) {
  if (!item) return '';
  return [
    `${item.type || 'Ítem'}: ${item.name} (${item.id})`,
    `Definición: ${item.definition || ''}`,
    `Condición: ${item.condition || 'Sin condición adicional.'}`,
  ].join('\n\n');
}

export function itemPromptDraft(item, saved) {
  const base = catalogItemPrompt(item);
  const effective = text => {
    if (saved?.application === 'replace') return text ?? base;
    if (!text?.trim()) return base;
    if (text === base || text.startsWith(`${base}\n`)) return text;
    return `${base}\n\nIndicaciones guardadas:\n${text}`;
  };
  return {
    application: 'replace',
    mode: saved?.mode || 'inherit',
    shared: saved?.mode === 'inherit' ? base : effective(saved?.shared),
    byModel: Object.fromEntries(models.map(id => [id, saved?.byModel?.[id] !== undefined && saved.byModel[id] !== '' ? effective(saved.byModel[id]) : ''])),
  };
}

export function changeItemPromptMode(item, value, mode) {
  const base = catalogItemPrompt(item);
  const shared = value.shared.trim() ? value.shared : value.mode === 'per-model' && value.byModel['clef-local'].trim() ? value.byModel['clef-local'] : base;
  return {
    ...value, mode,
    ...(mode === 'shared' ? { shared } : {}),
    ...(mode === 'per-model' ? {
      byModel: Object.fromEntries(models.map(id => [id, value.byModel[id].trim() ? value.byModel[id] : shared])),
    } : {}),
  };
}
