import { resolveWebPaths } from '../basePath.js';

export const { basePath, apiBaseUrl } = resolveWebPaths(import.meta.env || {});
