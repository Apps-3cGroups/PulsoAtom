export function normalizeBasePath(value = '/pulsoAtom') {
  const basePath = String(value).trim().replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(basePath)) {
    throw new Error('La ruta base debe ser una subruta como /pulsoAtom, sin dominio ni parámetros.');
  }
  return basePath;
}

export function resolveWebPaths(env = {}) {
  const basePath = normalizeBasePath(env.VITE_BASE_PATH || env.BASE_PATH || '/pulsoAtom');
  const apiBaseUrl = normalizeBasePath(env.VITE_API_BASE_URL || `${basePath}/api`);
  if (apiBaseUrl !== `${basePath}/api`) throw new Error('VITE_API_BASE_URL debe ser VITE_BASE_PATH seguido de /api.');
  return { basePath, apiBaseUrl };
}
