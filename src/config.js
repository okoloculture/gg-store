import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// Диска под SQLite на serverless не существует: молчаливый откат на него даёт
// невнятный ENOENT из глубины драйвера вместо понятной причины.
const isServerless = process.env.VERCEL === '1' || process.env.SERVERLESS === '1';

export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  port: num(process.env.PORT, 3210),
  host: process.env.HOST ?? '127.0.0.1',
  adminToken: process.env.ADMIN_TOKEN ?? 'dev-admin-token',
  cronSecret: process.env.CRON_SECRET ?? null,

  // sqlite — локальная разработка и тесты (нулевая настройка),
  // postgres — деплой на Vercel, где локального диска нет.
  dbDriver: (process.env.DB_DRIVER ?? (isServerless || process.env.DATABASE_URL ? 'postgres' : 'sqlite')).toLowerCase(),
  dbPath: process.env.DB_PATH ?? path.join(rootDir, 'data', 'store.db'),
  databaseUrl: process.env.DATABASE_URL ?? null,
  pgMaxConnections: num(process.env.PG_MAX_CONNECTIONS, 5),
  pgStatementTimeoutMs: num(process.env.PG_STATEMENT_TIMEOUT_MS, 15_000),

  // На serverless фоновой работы после ответа нет: выдачу приходится
  // дожидаться внутри обработчика вебхука.
  serverless: isServerless,
  publicBaseUrl: process.env.PUBLIC_BASE_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null),
  // Сколько опрос статуса ждёт запущенную им же выдачу, прежде чем ответить
  // текущим состоянием. Брошенная на полпути попытка безопасна: код закреплён
  // за детерминированным request_id, а заказ подберёт следующая попытка.
  serverlessDeliveryWaitMs: num(process.env.SERVERLESS_DELIVERY_WAIT_MS, 2000),

  // Аренда на выдачу: сколько заказ может провисеть в delivering, прежде чем
  // сверщик заберёт его у зависшего воркера.
  deliveryLeaseMs: num(process.env.DELIVERY_LEASE_MS, 15_000),
  // Повторы к ОДНОМУ поставщику с тем же request_id (таймаут не равен отказу).
  providerRetries: num(process.env.PROVIDER_RETRIES, 2),
  providerTimeoutMs: num(process.env.PROVIDER_TIMEOUT_MS, 1500),
  maxAutoDeliveryAttempts: num(process.env.MAX_AUTO_DELIVERY_ATTEMPTS, 5),
  reconcileIntervalMs: num(process.env.RECONCILE_INTERVAL_MS, 3000),
  // Сколько заглушка "висит" после выдачи кода, изображая потерянный ответ.
  providerHangMs: num(process.env.PROVIDER_HANG_MS, 60_000),

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
