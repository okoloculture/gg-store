import { config, ORDER_STATUS } from '../config.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { sendJson } from '../lib/http.js';
import { listOrders, getOrder } from '../services/orders.js';
import { deliverOrder } from '../services/delivery.js';
import { drainPool, getProviderConfig, refillPool, setProviderConfig, stockByProvider } from '../services/providerStub.js';
import { promoStats } from '../services/promo.js';
import { reconcileOnce } from '../services/reconciler.js';
import { audit, orderAudit } from '../services/audit.js';

const requireToken = (req) => {
  const token = req.headers['x-admin-token'] ?? '';
  if (token !== config.adminToken) throw unauthorized();
};

// Оплачено, но не выдано.
const STUCK = [ORDER_STATUS.PAID, ORDER_STATUS.DELIVERING, ORDER_STATUS.OUT_OF_STOCK, ORDER_STATUS.DELIVERY_FAILED];

export const registerAdminRoutes = (router) => {
  router.get('/api/admin/orders', async (req, res, { query }) => {
    requireToken(req);
    const filter = query.get('status');
    const status = filter === 'stuck' || !filter ? STUCK : filter.split(',');
    sendJson(res, 200, { orders: await listOrders({ status, limit: 200 }) });
  });

  router.get('/api/admin/stock', async (req, res) => {
    requireToken(req);
    const [stock, promocodes] = await Promise.all([stockByProvider(), promoStats()]);
    sendJson(res, 200, { stock, providers: getProviderConfig(), promocodes });
  });

  /**
   * Ручная повторная выдача. Идемпотентна: на уже выданном заказе возвращает
   * тот же код и не расходует новый ключ.
   */
  router.post('/api/admin/orders/:id/redeliver', async (req, res, { params }) => {
    requireToken(req);
    await getOrder(params.id);
    const result = await deliverOrder(params.id, { source: 'admin' });
    sendJson(res, 200, result);
  });

  router.post('/api/admin/keys/refill', async (req, res, { body }) => {
    requireToken(req);
    const provider = String(body.provider ?? '').toUpperCase();
    const sku = String(body.sku ?? '');
    if (!['A', 'B'].includes(provider)) throw badRequest('unknown_provider', 'provider должен быть A или B');
    if (!sku) throw badRequest('missing_sku', 'Не передан sku');

    const codes = Array.isArray(body.codes) && body.codes.length
      ? body.codes
      : Array.from({ length: Number(body.count) || 1 }, (unused, index) =>
          `RF${Date.now().toString(36).toUpperCase()}-${provider}${index}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`);

    const added = await refillPool({ provider, sku, codes });
    sendJson(res, 200, { added, stock: await stockByProvider() });
  });

  // Тестовая ручка: осушить пул, чтобы воспроизвести out_of_stock.
  router.post('/api/admin/keys/drain', async (req, res, { body }) => {
    requireToken(req);
    if (!body.sku) throw badRequest('missing_sku', 'Не передан sku');
    sendJson(res, 200, { drained: await drainPool({ sku: String(body.sku), provider: body.provider }) });
  });

  router.post('/api/admin/providers/config', (req, res, { body }) => {
    requireToken(req);
    sendJson(res, 200, { providers: setProviderConfig(body) });
  });

  router.post('/api/admin/reconcile', async (req, res) => {
    requireToken(req);
    sendJson(res, 200, await reconcileOnce());
  });

  router.get('/api/admin/audit', async (req, res) => {
    requireToken(req);
    sendJson(res, 200, await audit());
  });

  router.get('/api/admin/audit/:id', async (req, res, { params }) => {
    requireToken(req);
    sendJson(res, 200, await orderAudit(params.id));
  });

  router.get('/api/admin/orders/:id', async (req, res, { params }) => {
    requireToken(req);
    sendJson(res, 200, { order: await getOrder(params.id) });
  });
};
