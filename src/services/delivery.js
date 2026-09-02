import { randomUUID } from 'node:crypto';
import { sql } from '../db/index.js';
import { ORDER_STATUS, RECOVERABLE_STATUSES, config } from '../config.js';
import { logger } from '../lib/logger.js';
import { providerRequestId } from '../lib/ids.js';
import { PROVIDER_ORDER, requestCode } from './providerClient.js';
import { getDelivery, getOrderRow, serializeOrder } from './orders.js';

const inFlight = new Map();

const touch = (id, fields) => {
  const entries = Object.entries({ ...fields, updated_at: new Date().toISOString() });
  return sql.run(
    `UPDATE orders SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`,
    ...entries.map(([, value]) => value), id,
  );
};

/**
 * Захват аренды на выдачу.
 *
 * Условный UPDATE под BEGIN IMMEDIATE — единственная точка, где заказ может
 * перейти в delivering. При 50 параллельных попытках ровно одна получает
 * changes = 1; остальные видят 0 и выходят, не трогая пул.
 *
 * lease_token отличает "нашу" аренду от аренды воркера, который перехватил
 * зависший заказ по истечении lease_until.
 */
const claimLease = (orderId) =>
  sql.transaction(async () => {
    const order = await getOrderRow(orderId);
    if (!order) return { claimed: false, reason: 'order_not_found' };

    const delivered = await getDelivery(orderId);
    if (delivered) {
      if (order.status !== ORDER_STATUS.DELIVERED) {
        await touch(orderId, { status: ORDER_STATUS.DELIVERED, lease_until: null, lease_token: null });
      }
      return { claimed: false, reason: 'already_delivered' };
    }

    if (order.status === ORDER_STATUS.CREATED) return { claimed: false, reason: 'not_paid' };
    if (order.status === ORDER_STATUS.PAYMENT_FAILED) return { claimed: false, reason: 'payment_failed' };

    const now = Date.now();
    const token = randomUUID();
    const claimed = await sql.run(
      `UPDATE orders
          SET status = ?, lease_until = ?, lease_token = ?,
              delivery_attempts = delivery_attempts + 1, updated_at = ?
        WHERE id = ?
          AND (status IN (${RECOVERABLE_STATUSES.map(() => '?').join(',')})
               OR (status = ? AND (lease_until IS NULL OR lease_until < ?)))`,
      ORDER_STATUS.DELIVERING, now + config.deliveryLeaseMs, token, new Date().toISOString(),
      orderId, ...RECOVERABLE_STATUSES, ORDER_STATUS.DELIVERING, now,
    );

    if (claimed !== 1) return { claimed: false, reason: 'busy' };
    return {
      claimed: true,
      token,
      sku: order.sku,
      pendingProvider: order.pending_provider,
      attempts: order.delivery_attempts + 1,
    };
  });

/**
 * Фиксация успешной выдачи.
 *
 * PRIMARY KEY(deliveries.order_id) — последний барьер: даже если два воркера
 * каким-то образом дошли до сюда, строка выдачи появится ровно одна.
 * Второй получит changes = 0 и вернёт уже существующий код.
 */
const persistDelivery = ({ orderId, code, provider, requestId }) =>
  sql.transaction(async () => {
    const inserted = await sql.run(
      `INSERT OR IGNORE INTO deliveries (order_id, code, provider, request_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      orderId, code, provider, requestId, new Date().toISOString(),
    );

    await touch(orderId, {
      status: ORDER_STATUS.DELIVERED,
      lease_until: null,
      lease_token: null,
      pending_provider: null,
      last_error: null,
    });
    return { firstWrite: inserted === 1, delivery: await getDelivery(orderId) };
  });

const failDelivery = ({ orderId, token, status, reason, pendingProvider }) =>
  sql.transaction(async () => {
    const applied = await sql.run(
      `UPDATE orders
          SET status = ?, last_error = ?, pending_provider = ?,
              lease_until = NULL, lease_token = NULL, updated_at = ?
        WHERE id = ? AND status = ? AND lease_token = ?`,
      status, reason, pendingProvider ?? null, new Date().toISOString(),
      orderId, ORDER_STATUS.DELIVERING, token,
    );
    return applied === 1;
  });

/**
 * Обход поставщиков.
 *
 * Правило безопасного фолбэка: перейти к резервному поставщику можно ТОЛЬКО
 * после явного out_of_stock. По контракту поставщик, который уже выдал код под
 * этим request_id, обязан вернуть тот же код, а не out_of_stock — значит
 * out_of_stock доказывает, что этот поставщик ничего не списал.
 *
 * Таймаут и 5xx неотличимы от "код выдан, ответ потерян". После такого ответа
 * поставщик становится "залипшим" (pending_provider): все следующие попытки
 * идут только к нему и с тем же request_id, пока он не ответит определённо.
 * Иначе заказ мог бы забрать второй код у резервного поставщика.
 */
const attemptProviders = async ({ orderId, sku, pendingProvider }) => {
  const startIndex = pendingProvider ? Math.max(0, PROVIDER_ORDER.indexOf(pendingProvider)) : 0;
  const failures = [];

  for (let index = startIndex; index < PROVIDER_ORDER.length; index += 1) {
    const provider = PROVIDER_ORDER[index];
    const requestId = providerRequestId(orderId, provider);
    const result = await requestCode({ provider, sku, orderId, requestId });

    if (result.outcome === 'ok') {
      return { ok: true, provider, requestId, code: result.code };
    }

    failures.push({ provider, outcome: result.outcome, reason: result.reason });

    if (result.outcome !== 'out_of_stock') {
      return {
        ok: false,
        terminal: ORDER_STATUS.DELIVERY_FAILED,
        pendingProvider: provider,
        failures,
        reason: `provider_${provider}_${result.outcome}`,
      };
    }
  }

  return {
    ok: false,
    terminal: ORDER_STATUS.OUT_OF_STOCK,
    pendingProvider: null,
    failures,
    reason: 'out_of_stock',
  };
};

const currentOrder = async (orderId) => serializeOrder(await getOrderRow(orderId));

const runDelivery = async (orderId, source) => {
  const lease = await claimLease(orderId);
  if (!lease.claimed) {
    return {
      delivered: lease.reason === 'already_delivered',
      skipped: lease.reason,
      order: await currentOrder(orderId),
    };
  }

  logger.info('старт выдачи', { orderId, source, attempt: lease.attempts });
  const outcome = await attemptProviders({ orderId, sku: lease.sku, pendingProvider: lease.pendingProvider });

  if (outcome.ok) {
    const { firstWrite, delivery } = await persistDelivery({
      orderId, code: outcome.code, provider: outcome.provider, requestId: outcome.requestId,
    });
    logger.info('выдача завершена', { orderId, provider: outcome.provider, firstWrite, code: delivery.code });
    return { delivered: true, firstWrite, order: await currentOrder(orderId) };
  }

  await failDelivery({
    orderId,
    token: lease.token,
    status: outcome.terminal,
    reason: outcome.reason,
    pendingProvider: outcome.pendingProvider,
  });
  logger.warn('выдача не удалась', { orderId, status: outcome.terminal, reason: outcome.reason });
  return {
    delivered: false,
    status: outcome.terminal,
    reason: outcome.reason,
    order: await currentOrder(orderId),
  };
};

/**
 * Единственная точка входа в выдачу. Идемпотентна: повторный вызов на уже
 * выданном заказе ничего не меняет и возвращает тот же код.
 * Параллельные вызовы по одному заказу схлопываются в один запуск.
 */
export const deliverOrder = (orderId, { source = 'api' } = {}) => {
  const running = inFlight.get(orderId);
  if (running) return running;

  const promise = runDelivery(orderId, source).finally(() => inFlight.delete(orderId));
  inFlight.set(orderId, promise);
  return promise;
};

/**
 * Постановка выдачи в фон. На serverless фона не существует: всё, что не
 * завершилось до ответа, будет убито вместе с инстансом, поэтому там вызов
 * возвращает промис и обработчик его дожидается.
 */
export const enqueueDelivery = (orderId, options) => {
  const promise = deliverOrder(orderId, options).catch((error) => {
    logger.error('фоновая выдача упала', { orderId, error: error?.message });
  });
  return config.serverless ? promise : undefined;
};
