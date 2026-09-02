import { badRequest } from '../lib/errors.js';
import { eventId as generateEventId } from '../lib/ids.js';
import { sendJson } from '../lib/http.js';
import { createOrder, getOrder, getProduct, listProducts } from '../services/orders.js';
import { enqueueDelivery } from '../services/delivery.js';
import { parseWebhook, receiveWebhook, orderEvents } from '../services/payments.js';
import { previewPromo } from '../services/promo.js';
import { reconcileOrder } from '../services/reconciler.js';
import { config, ORDER_STATUS } from '../config.js';

const toProduct = (row) => ({
  sku: row.sku,
  name: row.name,
  type: row.type,
  price: row.price_minor / 100,
  price_minor: row.price_minor,
  currency: row.currency,
  image: row.image,
});

export const registerApiRoutes = (router) => {
  router.get('/api/health', (req, res) => sendJson(res, 200, { ok: true }));

  router.get('/api/catalog', async (req, res) => {
    const products = await listProducts();
    sendJson(res, 200, { products: products.map(toProduct) });
  });

  router.post('/api/promo/preview', async (req, res, { body }) => {
    const product = await getProduct(body.sku);
    if (!product) throw badRequest('unknown_sku', 'Товар не найден');
    sendJson(res, 200, await previewPromo(body.code, product));
  });

  /**
   * Создание заказа. Заголовок Idempotency-Key обязателен для UI:
   * двойной клик по "Купить" приходит с одним ключом и даёт один заказ.
   */
  router.post('/api/orders', async (req, res, { body }) => {
    const idempotencyKey = req.headers['idempotency-key'] ?? body.idempotency_key ?? null;
    const { order, reused } = await createOrder({
      sku: body.sku,
      promoCode: body.promo_code,
      steamLogin: body.steam_login,
      idempotencyKey,
      orderId: body.order_id,
    });
    sendJson(res, reused ? 200 : 201, { order, reused });
  });

  router.get('/api/orders/:id', async (req, res, { params }) => {
    // Без фонового сверщика (serverless) заказ доводит до конца сам опрос
    // статуса со страницы заказа.
    if (config.serverless) await reconcileOrder(params.id);
    const [order, events] = await Promise.all([getOrder(params.id), orderEvents(params.id)]);
    sendJson(res, 200, { order, events: events.length });
  });

  /**
   * Эмуляция оплаты: формирует вебхук по контракту и отправляет его
   * на собственный эндпоинт, как это сделала бы платёжная система.
   */
  router.post('/api/orders/:id/pay', async (req, res, { params, body, baseUrl }) => {
    const order = await getOrder(params.id);
    const outcome = body.outcome === 'fail' ? 'failed' : 'paid';
    if (order.status !== ORDER_STATUS.CREATED) {
      // Повторная "оплата" уже обработанного заказа ничего не меняет.
      sendJson(res, 200, { order, skipped: 'already_processed' });
      return;
    }

    const payload = {
      event_id: body.event_id ?? generateEventId(),
      order_id: order.id,
      status: outcome,
      amount: order.amount_minor / 100,
      currency: order.currency,
      created_at: new Date().toISOString(),
    };

    const response = await fetch(`${baseUrl}/api/webhooks/payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const webhook = await response.json().catch(() => ({}));
    sendJson(res, 200, { order: await getOrder(order.id), webhook, payload });
  });

  /**
   * Эндпоинт платёжной системы. Отвечает быстрым 200, выдача уходит в фон.
   */
  router.post('/api/webhooks/payment', async (req, res, { body }) => {
    const event = parseWebhook(body);
    const result = await receiveWebhook(event);

    if (result.status === ORDER_STATUS.PAID) {
      await enqueueDelivery(event.orderId, { source: 'webhook' });
    }

    sendJson(res, 200, {
      received: true,
      duplicate: result.duplicate,
      order_status: result.status,
      pending: result.orderExists === false,
    });
  });

  router.get('/api/orders/:id/events', async (req, res, { params }) => {
    const events = await orderEvents(params.id);
    if (!events.length) await getOrder(params.id);
    sendJson(res, 200, { events });
  });
};
