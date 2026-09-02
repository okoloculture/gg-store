import { config } from './config.js';
import { createRouter, handleError, readJsonBody, sendJson, serveStatic } from './lib/http.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerProviderRoutes } from './routes/provider.js';
import { registerCronRoutes } from './routes/cron.js';

const router = createRouter();
registerApiRoutes(router);
registerAdminRoutes(router);
registerProviderRoutes(router);
registerCronRoutes(router);

export const selfUrl = () => config.publicBaseUrl ?? `http://${config.host}:${config.port}`;

/**
 * Обработчик запроса, общий для локального node:http-сервера и функции на
 * Vercel. Статику отдаёт только локальный сервер: на Vercel public/ раздаётся
 * платформой, до функции такие запросы не доходят.
 */
export const createHandler = ({ static: withStatic = true } = {}) =>
  async (req, res) => {
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
          baseUrl: selfUrl(),
        });
        return;
      }

      if (withStatic && req.method === 'GET' && serveStatic(res, config.publicDir, url.pathname)) return;

      sendJson(res, 404, { error: { code: 'not_found', message: 'Маршрут не найден' } });
    } catch (error) {
      handleError(res, error, context);
    }
  };
