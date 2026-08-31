import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  port: num(process.env.PORT, 3210),
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: process.env.DB_PATH ?? path.join(rootDir, 'data', 'store.db'),
  adminToken: process.env.ADMIN_TOKEN ?? 'dev-admin-token',

  // Аренда на выдачу: сколько заказ может провисеть в delivering, прежде чем
  // сверщик заберёт его у зависшего воркера.
  deliveryLeaseMs: num(process.env.DELIVERY_LEASE_MS, 15_000),
  // Повторы к ОДНОМУ поставщику с тем же request_id (таймаут не равен отказу).
  providerRetries: num(process.env.PROVIDER_RETRIES, 2),
  providerTimeoutMs: num(process.env.PROVIDER_TIMEOUT_MS, 1500),
  maxAutoDeliveryAttempts: num(process.env.MAX_AUTO_DELIVERY_ATTEMPTS, 5),
  reconcileIntervalMs: num(process.env.RECONCILE_INTERVAL_MS, 3000),

  providers: {
    A: {
      failRate: num(process.env.PROVIDER_A_FAIL_RATE, 0.25),
      timeoutRate: num(process.env.PROVIDER_A_TIMEOUT_RATE, 0.15),
    },
    B: {
      failRate: num(process.env.PROVIDER_B_FAIL_RATE, 0.1),
      timeoutRate: num(process.env.PROVIDER_B_TIMEOUT_RATE, 0.05),
    },
  },
};

export const ORDER_STATUS = Object.freeze({
  CREATED: 'created',
  PAID: 'paid',
  DELIVERING: 'delivering',
  DELIVERED: 'delivered',
  PAYMENT_FAILED: 'payment_failed',
  OUT_OF_STOCK: 'out_of_stock',
  DELIVERY_FAILED: 'delivery_failed',
});

export const FINAL_STATUSES = Object.freeze([ORDER_STATUS.DELIVERED, ORDER_STATUS.PAYMENT_FAILED]);
// Из этих состояний выдачу можно (пере)запустить.
export const RECOVERABLE_STATUSES = Object.freeze([
  ORDER_STATUS.PAID,
  ORDER_STATUS.OUT_OF_STOCK,
  ORDER_STATUS.DELIVERY_FAILED,
]);
