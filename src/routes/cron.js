import { config } from '../config.js';
import { unauthorized } from '../lib/errors.js';
import { sendJson } from '../lib/http.js';
import { reconcileOnce } from '../services/reconciler.js';

/**
 * Сверка по расписанию. На serverless фонового процесса нет, поэтому роль
 * периодического сверщика играет планировщик платформы (Vercel Cron), а
 * между его запусками заказ доводит до конца опрос собственного статуса.
 */
export const registerCronRoutes = (router) => {
  const authorize = (req) => {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (config.cronSecret && bearer === config.cronSecret) return;
    if (req.headers['x-admin-token'] === config.adminToken) return;
    throw unauthorized('Требуется CRON_SECRET или токен администратора');
  };

  router.get('/api/cron/reconcile', async (req, res) => {
    authorize(req);
    sendJson(res, 200, await reconcileOnce());
  });
};
