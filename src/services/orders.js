import { db, inTransaction } from '../db/index.js';
import { ORDER_STATUS } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
import { orderId as generateOrderId } from '../lib/ids.js';
import { assertPromoInput, reservePromo } from './promo.js';

const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export const getProduct = (sku) =>
  db.prepare('SELECT * FROM products WHERE sku = ?').get(String(sku ?? '')) ?? null;

export const listProducts = () =>
  db.prepare('SELECT * FROM products ORDER BY position').all();

export const getOrderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id) ?? null;

export const getDelivery = (id) =>
  db.prepare('SELECT * FROM deliveries WHERE order_id = ?').get(id) ?? null;

export const serializeOrder = (order) => {
  if (!order) return null;
  const delivery = getDelivery(order.id);
  return {
    id: order.id,
    sku: order.sku,
    status: order.status,
    base_amount_minor: order.base_amount_minor,
    discount_minor: order.discount_minor,
    amount_minor: order.amount_minor,
    amount: order.amount_minor / 100,
    currency: order.currency,
    promo_code: order.promo_code,
    steam_login: order.steam_login,
    delivery_attempts: order.delivery_attempts,
    last_error: order.last_error,
    created_at: order.created_at,
    updated_at: order.updated_at,
    delivery: delivery
      ? { code: delivery.code, provider: delivery.provider, issued_at: delivery.created_at }
      : null,
  };
};

export const getOrder = (id) => {
  const order = getOrderRow(id);
  if (!order) throw notFound('order_not_found', 'Заказ не найден');
  return serializeOrder(order);
};

/**
 * Создание заказа.
 *
 * Идемпотентность двойного клика: клиент шлёт Idempotency-Key, одинаковый для
 * всех кликов одной покупки. UNIQUE(idempotency_key) не даёт создать второй
 * заказ, вместо ошибки возвращается уже созданный.
 *
 * Промокод резервируется в ТОЙ ЖЕ транзакции: заказ без слота или слот без
 * заказа существовать не могут.
 */
export const createOrder = ({ sku, promoCode, steamLogin, idempotencyKey, orderId }) => {
  const product = getProduct(sku);
  if (!product) throw badRequest('unknown_sku', 'Товар не найден');

  const promo = assertPromoInput(promoCode);
  const login = steamLogin ? String(steamLogin).slice(0, 64) : null;

  if (idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM orders WHERE idempotency_key = ?')
      .get(String(idempotencyKey));
    if (existing) return { order: serializeOrder(existing), reused: true };
  }

  const id = orderId ? String(orderId) : generateOrderId();
  if (!ORDER_ID_RE.test(id)) throw badRequest('invalid_order_id', 'Некорректный идентификатор заказа');

  try {
    const created = inTransaction(() => {
      if (idempotencyKey) {
        const existing = db
          .prepare('SELECT * FROM orders WHERE idempotency_key = ?')
          .get(String(idempotencyKey));
        if (existing) return { order: existing, reused: true };
      }
      const duplicateId = db.prepare('SELECT 1 FROM orders WHERE id = ?').get(id);
      if (duplicateId) throw badRequest('order_exists', 'Заказ с таким идентификатором уже существует');

      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO orders (id, sku, status, base_amount_minor, discount_minor, amount_minor,
                             currency, promo_code, steam_login, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, ?)`,
      ).run(id, product.sku, ORDER_STATUS.CREATED, product.price_minor, product.price_minor,
        product.currency, login, idempotencyKey ? String(idempotencyKey) : null, now, now);

      if (promo) {
        const reserved = reservePromo(promo, id, product.price_minor);
        db.prepare('UPDATE orders SET promo_code = ?, discount_minor = ?, amount_minor = ? WHERE id = ?')
          .run(reserved.code, reserved.discount_minor, product.price_minor - reserved.discount_minor, id);
      }

      return { order: getOrderRow(id), reused: false };
    });

    return { order: serializeOrder(created.order), reused: created.reused };
  } catch (error) {
    // Гонка на UNIQUE(idempotency_key): второй клик проиграл вставку — отдаём первый заказ.
    if (idempotencyKey && /UNIQUE constraint failed: orders.idempotency_key/.test(error?.message ?? '')) {
      const existing = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(String(idempotencyKey));
      if (existing) return { order: serializeOrder(existing), reused: true };
    }
    throw error;
  }
};

export const listOrders = ({ status, limit = 100 } = {}) => {
  const statuses = Array.isArray(status) ? status : status ? [status] : null;
  const rows = statuses
    ? db
        .prepare(
          `SELECT * FROM orders WHERE status IN (${statuses.map(() => '?').join(',')})
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...statuses, limit)
    : db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map(serializeOrder);
};
