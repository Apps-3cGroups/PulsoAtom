import { reviewSelectionId } from './reviewSelection.js';

const origins = {
  '/': { label: 'Resumen', action: 'Volver al resumen' },
  '/activas': { label: 'Activas', action: 'Volver a Activas' },
  '/historico': { label: 'Histórico', action: 'Volver al histórico' },
  '/busqueda': { label: 'Búsqueda', action: 'Volver a Búsqueda' },
};
export function conversationLink(id, returnTo, message) {
  const params = new URLSearchParams({ returnTo });
  try {
    const source = new URL(returnTo, 'https://pulso.invalid');
    const selection = source.origin === 'https://pulso.invalid' && origins[source.pathname] && reviewSelectionId(source.searchParams);
    if (selection) params.set('reviewSelection', selection);
  } catch { /* Invalid origins are handled by conversationReturn. */ }
  if (message) params.set('message', message);
  return `/conversacion/${encodeURIComponent(id)}?${params}`;
}
export function conversationReturn(params) {
  try {
    const url = new URL(params.get('returnTo') || '/historico', 'https://pulso.invalid');
    if (url.origin === 'https://pulso.invalid' && origins[url.pathname]) return { to: `${url.pathname}${url.search}`, ...origins[url.pathname] };
  } catch { /* Direct links use the historical list. */ }
  return { to: '/historico', ...origins['/historico'] };
}
