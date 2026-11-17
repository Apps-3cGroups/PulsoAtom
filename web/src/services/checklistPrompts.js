export const itemPromptMaxLength = 12000;
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
  return {
    mode: saved?.mode || 'inherit',
    shared: saved?.shared ?? catalogItemPrompt(item),
    byModel: Object.fromEntries(models.map(id => [id, saved?.byModel?.[id] ?? ''])),
  };
}

export function changeItemPromptMode(item, value, mode) {
  const base = catalogItemPrompt(item);
  const shared = value.shared.trim() ? value.shared : base;
  return {
    ...value, mode,
    ...(mode === 'shared' ? { shared } : {}),
    ...(mode === 'per-model' ? {
      byModel: Object.fromEntries(models.map(id => [id, value.byModel[id].trim() ? value.byModel[id] : shared])),
    } : {}),
  };
}
