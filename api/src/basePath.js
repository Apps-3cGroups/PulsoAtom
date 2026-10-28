export function normalizeBasePath(value = '/pulsoAtom') {
  const basePath = String(value).trim().replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(basePath)) {
    throw new Error('BASE_PATH debe ser una subruta como /pulsoAtom, sin dominio ni parámetros.');
  }
  return basePath;
}
