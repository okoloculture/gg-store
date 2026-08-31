import { db } from '../db/index.js';
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
export const reconcileOnce = () => {
  const result = { appliedEvents: 0, requeued: 0, retried: 0 };

  for (const orderId of pendingEventOrderIds()) {
    const applied = applyPaymentEvents(orderId);
    if (!applied.orderExists) continue;
    result.appliedEvents += 1;
    if (applied.status === ORDER_STATUS.PAID) enqueueDelivery(orderId, { source: 'reconciler:event' });
  }

  const stale = db
    .prepare('SELECT id FROM orders WHERE status = ? AND (lease_until IS NULL OR lease_until < ?)')
    .all(ORDER_STATUS.DELIVERING, Date.now());
  for (const row of stale) {
    result.requeued += 1;
    enqueueDelivery(row.id, { source: 'reconciler:stale-lease' });
  }

  const retryable = db
    .prepare('SELECT id FROM orders WHERE status IN (?, ?) AND delivery_attempts < ?')
    .all(ORDER_STATUS.PAID, ORDER_STATUS.DELIVERY_FAILED, config.maxAutoDeliveryAttempts);
  for (const row of retryable) {
    result.retried += 1;
    enqueueDelivery(row.id, { source: 'reconciler:retry' });
  }

  if (result.appliedEvents || result.requeued || result.retried) {
    logger.debug('сверка', result);
  }
  return result;
};

export const startReconciler = () => {
  const timer = setInterval(() => {
    try {
      reconcileOnce();
    } catch (error) {
      logger.error('сверка упала', { error: error?.message });
    }
  }, config.reconcileIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
};
