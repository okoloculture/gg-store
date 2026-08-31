import { ORDER_STATUS } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
import { eventId as generateEventId } from '../lib/ids.js';
import { sendJson } from '../lib/http.js';
import { createOrder, getOrder, getProduct, listProducts } from '../services/orders.js';
import { enqueueDelivery } from '../services/delivery.js';
import { parseWebhook, receiveWebhook, orderEvents } from '../services/payments.js';
import { previewPromo } from '../services/promo.js';

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

  router.get('/api/catalog', (req, res) => {
    sendJson(res, 200, { products: listProducts().map(toProduct) });
  });

  router.post('/api/promo/preview', (req, res, { body }) => {
    const product = getProduct(body.sku);
    if (!product) throw badRequest('unknown_sku', 'Товар не найден');
    sendJson(res, 200, previewPromo(body.code, product));
  });

  /**
   * Создание заказа. Заголовок Idempotency-Key обязателен для UI:
   * двойной клик по "Купить" приходит с одним ключом и даёт один заказ.
   */
  router.post('/api/orders', (req, res, { body }) => {
    const idempotencyKey = req.headers['idempotency-key'] ?? body.idempotency_key ?? null;
    const { order, reused } = createOrder({
      sku: body.sku,
      promoCode: body.promo_code,
      steamLogin: body.steam_login,
      idempotencyKey,
      orderId: body.order_id,
    });
    sendJson(res, reused ? 200 : 201, { order, reused });
  });

  router.get('/api/orders/:id', (req, res, { params }) => {
    sendJson(res, 200, { order: getOrder(params.id), events: orderEvents(params.id).length });
  });

  /**
   * Эмуляция оплаты: формирует вебхук по контракту и отправляет его
   * на собственный эндпоинт, как это сделала бы платёжная система.
   */
  router.post('/api/orders/:id/pay', async (req, res, { params, body, baseUrl }) => {
    const order = getOrder(params.id);
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
    sendJson(res, 200, { order: getOrder(order.id), webhook, payload });
  });

  /**
   * Эндпоинт платёжной системы. Отвечает быстрым 200, выдача уходит в фон.
   */
  router.post('/api/webhooks/payment', (req, res, { body }) => {
    const event = parseWebhook(body);
    const result = receiveWebhook(event);

    if (result.status === ORDER_STATUS.PAID) {
      enqueueDelivery(event.orderId, { source: 'webhook' });
    }

    sendJson(res, 200, {
      received: true,
      duplicate: result.duplicate,
      order_status: result.status,
      pending: result.orderExists === false,
    });
  });

  router.get('/api/orders/:id/events', (req, res, { params }) => {
    const events = orderEvents(params.id);
    if (!events.length && !getOrder(params.id)) throw notFound('order_not_found', 'Заказ не найден');
    sendJson(res, 200, { events });
  });
};
