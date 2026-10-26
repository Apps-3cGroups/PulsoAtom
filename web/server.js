import dotenv from 'dotenv';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
dotenv.config({ path: path.join(root, '.env'), quiet: true });
export function createWebServer({ apiTarget = process.env.API_TARGET || 'http://127.0.0.1:4001', dist = path.join(root, 'dist') } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(createProxyMiddleware({ pathFilter: '/pulso/api', target: apiTarget, changeOrigin: false, on: { error: (_error, _req, res) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'API_UNAVAILABLE', message: 'La API de Pulso no está disponible. Inicia el servidor de api/.' } })); } } }));
  app.use('/pulso', express.static(dist, { index: false }));
  app.use('/pulso', (req, res, next) => {
    if (req.method !== 'GET' || path.extname(req.path) || !req.accepts('html')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
  app.use((_req, res) => res.status(404).send('Ruta no encontrada. Abre /pulso.'));
  return app;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.WEB_HOST || '127.0.0.1';
  const port = Number(process.env.WEB_PORT || 3000);
  createWebServer().listen(port, host, () => console.log(`Pulso: http://${host}:${port}/pulso/`));
}
