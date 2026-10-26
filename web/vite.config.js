import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: '/pulso/',
    plugins: [react()],
    server: {
      host: env.WEB_HOST || '127.0.0.1',
      port: Number(env.WEB_PORT || 3000),
      strictPort: true,
      proxy: { '/pulso/api': { target: env.API_TARGET || 'http://127.0.0.1:4001' } },
    },
  };
});
