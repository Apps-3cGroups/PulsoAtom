const origins = {
  '/': { label: 'Resumen', action: 'Volver al resumen' },
  '/activas': { label: 'Activas', action: 'Volver a Activas' },
  '/historico': { label: 'Histórico', action: 'Volver al histórico' },
  '/busqueda': { label: 'Búsqueda', action: 'Volver a Búsqueda' },
};
export function conversationLink(id, returnTo, message) {
  const params = new URLSearchParams({ returnTo });
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
