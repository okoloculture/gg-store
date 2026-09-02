import { sql } from '../db/index.js';
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
 *
 * Строка заказа берётся под блокировку: параллельные вебхуки по одному заказу
 * должны сворачивать журнал по очереди, а не по одному снимку данных.
 */
export const applyPaymentEvents = (orderId) =>
  sql.transaction(async () => {
    const order = await sql.get(`SELECT * FROM orders WHERE id = ?${sql.forUpdate}`, orderId);
    if (!order) return { orderExists: false, status: null };

    const hasPaid = Boolean(
      await sql.get("SELECT 1 AS found FROM payment_events WHERE order_id = ? AND status = 'paid' LIMIT 1", orderId),
    );
    const now = new Date().toISOString();

    if (hasPaid) {
      const moved = await sql.run(
        `UPDATE orders SET status = ?, updated_at = ?
          WHERE id = ? AND status IN (?, ?)`,
        ORDER_STATUS.PAID, now, orderId, ORDER_STATUS.CREATED, ORDER_STATUS.PAYMENT_FAILED,
      );

      // Оплата пришла после отказа (перестановка вебхуков): возвращаем ранее
      // освобождённый слот промокода. Если лимит уже разобрали — скидку у
      // оплаченного заказа не отбираем, только пишем предупреждение.
      if (moved === 1 && order.status === ORDER_STATUS.PAYMENT_FAILED && order.promo_code) {
        try {
          const released = await sql.get(
            'SELECT 1 AS found FROM promo_redemptions WHERE order_id = ? AND released_at IS NOT NULL', orderId,
          );
          if (released) {
            await sql.run('DELETE FROM promo_redemptions WHERE order_id = ?', orderId);
            await reservePromo(order.promo_code, orderId, order.base_amount_minor);
          }
        } catch (error) {
          logger.warn('не удалось вернуть слот промокода при поздней оплате', {
            orderId, promo: order.promo_code, error: error?.message,
          });
        }
      }
    } else {
      const moved = await sql.run(
        'UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
        ORDER_STATUS.PAYMENT_FAILED, now, orderId, ORDER_STATUS.CREATED,
      );
      if (moved === 1) await releasePromo(orderId);
    }

    await sql.run(
      'UPDATE payment_events SET applied_at = ? WHERE order_id = ? AND applied_at IS NULL', now, orderId,
    );

    return { orderExists: true, status: (await getOrderRow(orderId)).status };
  });

/**
 * Приём вебхука. Идемпотентность обеспечена PRIMARY KEY(event_id):
 * повторная доставка того же события не проходит вставку и не меняет ничего.
 */
export const receiveWebhook = async (event) => {
  const inserted = await sql.transaction(() =>
    sql.run(
      `INSERT OR IGNORE INTO payment_events
         (event_id, order_id, status, amount_minor, currency, created_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      event.eventId, event.orderId, event.status, event.amountMinor, event.currency,
      event.createdAt, new Date().toISOString(),
    ));

  if (inserted === 0) {
    const order = await getOrderRow(event.orderId);
    return { duplicate: true, orderExists: Boolean(order), status: order?.status ?? null };
  }

  const applied = await applyPaymentEvents(event.orderId);
  if (!applied.orderExists) {
    // Вебхук пришёл раньше заказа: событие сохранено и будет применено
    // при создании заказа или ближайшей сверкой. Ничего не теряется.
    logger.info('вебхук раньше заказа, событие отложено', { orderId: event.orderId, eventId: event.eventId });
  }
  return { duplicate: false, ...applied };
};

export const pendingEventOrderIds = async () => {
  const rows = await sql.all('SELECT DISTINCT order_id FROM payment_events WHERE applied_at IS NULL');
  return rows.map((row) => row.order_id);
};

export const orderEvents = (orderId) =>
  sql.all('SELECT * FROM payment_events WHERE order_id = ? ORDER BY received_at', orderId);
