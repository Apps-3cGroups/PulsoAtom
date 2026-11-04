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
    plugins: [{
      name: 'pulso-exact-base-path',
      apply: 'serve',
      configureServer(server) {
        // React Router may remove the trailing slash when updating query
        // parameters. Normalize only the exact portal root before Vite's
        // base middleware; preserve the query and leave API/deep links alone.
        server.middlewares.use((req, _res, next) => {
          const url = req.url || '';
          const queryIndex = url.indexOf('?');
          const pathname = queryIndex < 0 ? url : url.slice(0, queryIndex);
          if (['GET', 'HEAD'].includes(req.method) && pathname === basePath) {
            req.url = `${basePath}/${queryIndex < 0 ? '' : url.slice(queryIndex)}`;
          }
          next();
        });
      },
    }, react()],
    server: {
      host: env.WEB_HOST || '127.0.0.1',
      port: Number(env.PORT || env.WEB_PORT || 3000),
      strictPort: true,
      proxy: { [apiBaseUrl]: { target: env.API_PROXY_TARGET || env.API_TARGET || 'http://127.0.0.1:4001' } },
    },
  };
});
