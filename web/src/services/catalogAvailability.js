// Existing non-AI implementations are advertised by the backend. Editing a
// definition must not turn an unavailable integration into an enabled rule.
export function canActivateCatalogDraft(item, values) {
  if (item?.template || values.template || Number(values.phase) !== 1) return false;
  if (values.type === 'Flag' && values.method === 'IA') return true;
  return !!item && item.availability?.canActivate === true
    && values.type === item.type && values.method === item.method
    && Number(values.phase) === Number(item.phase);
}

export function canActivateCatalogItem(item) {
  if (item.availability?.canActivate === false) return false;
  return canActivateCatalogDraft(item, item);
}

export function activationReason(item, values = item) {
  if (item?.template) return 'Crea una variable concreta a partir de esta plantilla.';
  if (Number(values.phase) > 1) return 'Pendiente de integración o de una fase posterior. Puedes guardar su definición, pero no habilitarla todavía.';
  if (!canActivateCatalogDraft(item, values)) return item?.availability?.reason || 'Este tipo de evaluación necesita una implementación antes de habilitarse.';
  return item?.availability?.status === 'pending' ? item.availability.reason : 'Se incluirá en futuras evaluaciones. Si faltan datos, quedará pendiente con el motivo visible.';
}
