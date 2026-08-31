import http from 'node:http';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { createRouter, handleError, readJsonBody, sendJson, serveStatic } from './lib/http.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerProviderRoutes } from './routes/provider.js';
import { startReconciler } from './services/reconciler.js';
import { seed } from './db/seed.js';

seed();

const router = createRouter();
registerApiRoutes(router);
registerAdminRoutes(router);
registerProviderRoutes(router);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const context = { method: req.method, path: url.pathname };

  try {
    const route = router.match(req.method, url.pathname);
    if (route) {
      const body = await readJsonBody(req);
      await route.handler(req, res, {
        params: route.params,
        query: url.searchParams,
        body,
        baseUrl: `http://${config.host}:${config.port}`,
      });
      return;
    }

    if (req.method === 'GET' && serveStatic(res, config.publicDir, url.pathname)) return;

    sendJson(res, 404, { error: { code: 'not_found', message: 'Маршрут не найден' } });
  } catch (error) {
    handleError(res, error, context);
  }
});

server.listen(config.port, config.host, () => {
  logger.info('сервер запущен', {
    url: `http://${config.host}:${config.port}`,
    admin: `http://${config.host}:${config.port}/admin.html`,
  });
});

const stopReconciler = startReconciler();

const shutdown = () => {
  stopReconciler();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
