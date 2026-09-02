import { sql } from '../db/index.js';
import { ORDER_STATUS, config } from '../config.js';
import { logger } from '../lib/logger.js';
import { enqueueDelivery } from './delivery.js';
import { applyPaymentEvents, pendingEventOrderIds } from './payments.js';

/**
 * Фоновая сверка. Закрывает три дыры, которые не может закрыть один запрос:
 *  1. вебхук пришёл раньше заказа — событие лежало неприменённым;
 *  2. воркер умер, держа аренду — заказ завис в delivering;
 *  3. временный отказ поставщика — ограниченное число автоповторов.
 * out_of_stock не трогаем: он лечится пополнением пула через админку.
 */
export const reconcileOnce = async () => {
  const result = { appliedEvents: 0, requeued: 0, retried: 0 };
  const pending = [];

  for (const orderId of await pendingEventOrderIds()) {
    const applied = await applyPaymentEvents(orderId);
    if (!applied.orderExists) continue;
    result.appliedEvents += 1;
    if (applied.status === ORDER_STATUS.PAID) {
      pending.push(enqueueDelivery(orderId, { source: 'reconciler:event' }));
    }
  }

  const stale = await sql.all(
    'SELECT id FROM orders WHERE status = ? AND (lease_until IS NULL OR lease_until < ?)',
    ORDER_STATUS.DELIVERING, Date.now(),
  );
  for (const row of stale) {
    result.requeued += 1;
    pending.push(enqueueDelivery(row.id, { source: 'reconciler:stale-lease' }));
  }

  const retryable = await sql.all(
    'SELECT id FROM orders WHERE status IN (?, ?) AND delivery_attempts < ?',
    ORDER_STATUS.PAID, ORDER_STATUS.DELIVERY_FAILED, config.maxAutoDeliveryAttempts,
  );
  for (const row of retryable) {
    result.retried += 1;
    pending.push(enqueueDelivery(row.id, { source: 'reconciler:retry' }));
  }

  // На serverless enqueueDelivery возвращает промис: сверку нельзя завершить
  // раньше, чем отработают запущенные ею выдачи.
  await Promise.all(pending);

  if (result.appliedEvents || result.requeued || result.retried) {
    logger.debug('сверка', result);
  }
  return result;
};

/**
 * Точечная сверка одного заказа. Нужна там, где нет фонового процесса
 * (serverless): страница статуса опрашивает заказ, и этот опрос сам доводит
 * его до конца — применяет отложенные события, перезапускает выдачу после
 * протухшей аренды или временного отказа поставщика.
 */
export const reconcileOrder = async (orderId) => {
  const pending = await sql.get(
    'SELECT 1 AS found FROM payment_events WHERE order_id = ? AND applied_at IS NULL', orderId,
  );
  if (pending) await applyPaymentEvents(orderId);

  const order = await sql.get(
    'SELECT status, delivery_attempts, lease_until, updated_at FROM orders WHERE id = ?', orderId,
  );
  if (!order) return false;

  // Пауза между автоповторами. Фоновый сверщик ограничен своим интервалом, а
  // опрос статуса приходит каждые 150 мс и без этой выдержки израсходовал бы
  // весь бюджет попыток за пару секунд, пока поставщик ещё лежит.
  const sinceUpdate = Date.now() - Date.parse(order.updated_at);
  const cooledDown = !Number.isFinite(sinceUpdate) || sinceUpdate >= config.reconcileIntervalMs;

  const retryable = [ORDER_STATUS.PAID, ORDER_STATUS.DELIVERY_FAILED].includes(order.status)
    && order.delivery_attempts < config.maxAutoDeliveryAttempts
    && cooledDown;
  const staleLease = order.status === ORDER_STATUS.DELIVERING
    && (order.lease_until === null || Number(order.lease_until) < Date.now());

  if (!retryable && !staleLease) return false;

  // Опрос статуса не должен превращаться в многосекундный запрос из-за
  // зависшего поставщика: ждём ограниченное время и отвечаем тем, что есть.
  const delivery = enqueueDelivery(orderId, { source: 'reconciler:order' });
  if (delivery) {
    let timer;
    const capped = new Promise((resolve) => {
      timer = setTimeout(resolve, config.serverlessDeliveryWaitMs);
    });
    await Promise.race([delivery, capped]);
    clearTimeout(timer);
  }
  return true;
};

export const startReconciler = () => {
  const timer = setInterval(() => {
    reconcileOnce().catch((error) => {
      logger.error('сверка упала', { error: error?.message });
    });
  }, config.reconcileIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
};
