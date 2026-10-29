import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveWebPaths } from './basePath.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const { basePath, apiBaseUrl } = resolveWebPaths(env);
  return {
    base: `${basePath}/`,
    define: {
      'import.meta.env.VITE_BASE_PATH': JSON.stringify(basePath),
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiBaseUrl),
    },
    plugins: [react()],
    server: {
      host: env.WEB_HOST || '127.0.0.1',
      port: Number(env.PORT || env.WEB_PORT || 3000),
      strictPort: true,
      proxy: { [apiBaseUrl]: { target: env.API_PROXY_TARGET || env.API_TARGET || 'http://127.0.0.1:4001' } },
    },
  };
});
