import { db, inTransaction } from '../db/index.js';
import { ORDER_STATUS } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getOrderRow } from './orders.js';
import { releasePromo, reservePromo } from './promo.js';

const ALLOWED_STATUSES = new Set(['paid', 'failed']);

export const parseWebhook = (body) => {
  const eventId = String(body?.event_id ?? '').trim();
  const orderId = String(body?.order_id ?? '').trim();
  const status = String(body?.status ?? '').trim().toLowerCase();

  if (!eventId) throw badRequest('missing_event_id', 'Не передан event_id');
  if (!orderId) throw badRequest('missing_order_id', 'Не передан order_id');
  if (!ALLOWED_STATUSES.has(status)) throw badRequest('invalid_status', 'status должен быть paid или failed');

  const amount = Number(body?.amount);
  return {
    eventId,
    orderId,
    status,
    amountMinor: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    currency: body?.currency ? String(body.currency) : null,
    createdAt: body?.created_at ? String(body.created_at) : null,
  };
};

/**
 * Свёртка журнала событий в статус заказа.
 *
 * Функция не зависит от порядка прихода вебхуков: она смотрит на ВЕСЬ журнал
 * заказа, а не на конкретное событие. Поэтому "failed, затем paid" и
 * "paid, затем failed" дают одинаковый результат, а успешная оплата не может
 * быть потеряна из-за позднего failed.
 */
export const applyPaymentEvents = (orderId) =>
  inTransaction(() => {
    const order = getOrderRow(orderId);
    if (!order) return { orderExists: false, status: null };

    const hasPaid = Boolean(
      db.prepare("SELECT 1 FROM payment_events WHERE order_id = ? AND status = 'paid' LIMIT 1").get(orderId),
    );
    const now = new Date().toISOString();

    if (hasPaid) {
      const moved = db
        .prepare(
          `UPDATE orders SET status = ?, updated_at = ?
            WHERE id = ? AND status IN (?, ?)`,
        )
        .run(ORDER_STATUS.PAID, now, orderId, ORDER_STATUS.CREATED, ORDER_STATUS.PAYMENT_FAILED).changes;

      // Оплата пришла после отказа (перестановка вебхуков): возвращаем ранее
      // освобождённый слот промокода. Если лимит уже разобрали — скидку у
      // оплаченного заказа не отбираем, только пишем предупреждение.
      if (moved === 1 && order.status === ORDER_STATUS.PAYMENT_FAILED && order.promo_code) {
        try {
          const released = db
            .prepare('SELECT 1 FROM promo_redemptions WHERE order_id = ? AND released_at IS NOT NULL')
            .get(orderId);
          if (released) {
            db.prepare('DELETE FROM promo_redemptions WHERE order_id = ?').run(orderId);
            reservePromo(order.promo_code, orderId, order.base_amount_minor);
          }
        } catch (error) {
          logger.warn('не удалось вернуть слот промокода при поздней оплате', {
            orderId, promo: order.promo_code, error: error?.message,
          });
        }
      }
    } else {
      const moved = db
        .prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
        .run(ORDER_STATUS.PAYMENT_FAILED, now, orderId, ORDER_STATUS.CREATED).changes;
      if (moved === 1) releasePromo(orderId);
    }

    db.prepare('UPDATE payment_events SET applied_at = ? WHERE order_id = ? AND applied_at IS NULL')
      .run(now, orderId);

    return { orderExists: true, status: getOrderRow(orderId).status };
  });

/**
 * Приём вебхука. Идемпотентность обеспечена PRIMARY KEY(event_id):
 * повторная доставка того же события не проходит вставку и не меняет ничего.
 */
export const receiveWebhook = (event) => {
  const inserted = inTransaction(
    () =>
      db
        .prepare(
          `INSERT OR IGNORE INTO payment_events
             (event_id, order_id, status, amount_minor, currency, created_at, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(event.eventId, event.orderId, event.status, event.amountMinor, event.currency,
          event.createdAt, new Date().toISOString()).changes,
  );

  if (inserted === 0) {
    const order = getOrderRow(event.orderId);
    return { duplicate: true, orderExists: Boolean(order), status: order?.status ?? null };
  }

  const applied = applyPaymentEvents(event.orderId);
  if (!applied.orderExists) {
    // Вебхук пришёл раньше заказа: событие сохранено и будет применено
    // при создании заказа или ближайшей сверкой. Ничего не теряется.
    logger.info('вебхук раньше заказа, событие отложено', { orderId: event.orderId, eventId: event.eventId });
  }
  return { duplicate: false, ...applied };
};

export const pendingEventOrderIds = () =>
  db
    .prepare('SELECT DISTINCT order_id FROM payment_events WHERE applied_at IS NULL')
    .all()
    .map((row) => row.order_id);

export const orderEvents = (orderId) =>
  db.prepare('SELECT * FROM payment_events WHERE order_id = ? ORDER BY received_at').all(orderId);
