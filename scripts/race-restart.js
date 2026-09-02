/**
 * Жёсткий сбой: процесс убит (SIGKILL) в момент выдачи, когда поставщик уже
 * списал код, а заказ висит в delivering.
 *
 * Ожидание: после перезапуска сверка сама доводит заказ до delivered,
 * возвращая ТОТ ЖЕ код по тому же request_id. Второй ключ не расходуется.
 *
 * Скрипт поднимает и убивает собственный сервер на отдельном порту и БД,
 * основной сервер ему не нужен.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, section, sleep } from './lib.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.RESTART_PORT ?? 3299);
const DB = path.join(root, 'data', 'restart-test.db');
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Сценарию нужна отдельная БД: он считает выдачи и ключи по всей базе.
 * В режиме Postgres берётся отдельная база (по умолчанию — имя основной с
 * суффиксом _restart), в режиме SQLite — отдельный файл.
 */
const RESTART_DATABASE_URL = process.env.DATABASE_URL
  ? process.env.RESTART_DATABASE_URL
    ?? process.env.DATABASE_URL.replace(/\/([^/?]+)(\?|$)/, '/$1_restart$2')
  : null;

const dbEnv = RESTART_DATABASE_URL
  ? { DB_DRIVER: 'postgres', DATABASE_URL: RESTART_DATABASE_URL }
  : { DB_DRIVER: 'sqlite', DATABASE_URL: '', DB_PATH: DB };

const resetDatabase = () => {
  if (!RESTART_DATABASE_URL) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${DB}${suffix}`, { force: true });
    return;
  }
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/db/seed.js', '--reset'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, ...dbEnv, LOG_LEVEL: 'error' },
  });
  if (done.status !== 0) {
    process.stdout.write(`не удалось подготовить базу ${RESTART_DATABASE_URL}\n`);
    process.exit(1);
  }
};

const call = async (method, urlPath, body, headers) => {
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const admin = (method, urlPath, body) => call(method, urlPath, body, { 'x-admin-token': 'dev-admin-token' });

const startServer = (env) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: root,
    stdio: 'ignore',
    // Сервер сценария поднимается на своём порту: адрес, по которому магазин
    // ходит в собственные заглушки поставщиков, должен указывать на него же.
    env: { ...process.env, ...dbEnv, PORT: String(PORT), PUBLIC_BASE_URL: BASE,
      DELIVERY_LEASE_MS: '2500', RECONCILE_INTERVAL_MS: '1000', LOG_LEVEL: 'error', ...env },
  });
  return child;
};

const waitHealthy = async (timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await call('GET', '/api/health')).status === 200) return true;
    } catch {
      // сервер ещё поднимается
    }
    await sleep(150);
  }
  return false;
};

const waitStatus = async (id, statuses, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await call('GET', `/api/orders/${id}`);
    if (statuses.includes(body?.order?.status)) return body.order;
    await sleep(150);
  }
  return null;
};

const run = async () => {
  resetDatabase();

  section('Поднимаем отдельный сервер, поставщик A зависает после списания кода');
  let server = startServer({ PROVIDER_A_TIMEOUT_RATE: '1', PROVIDER_A_FAIL_RATE: '0' });
  check('сервер поднялся', await waitHealthy());

  const created = await call('POST', '/api/orders', { sku: 'KEY-CS2-PRIME' },
    { 'idempotency-key': `restart-${Date.now()}` });
  const orderId = created.body.order.id;
  await call('POST', `/api/orders/${orderId}/pay`, { outcome: 'success' });

  const delivering = await waitStatus(orderId, ['delivering'], 10000);
  check('заказ дошёл до delivering', delivering?.status === 'delivering', delivering?.status);

  const beforeKill = await admin('GET', `/api/admin/audit/${orderId}`);
  const reserved = beforeKill.body.provider_issues[0]?.code;
  check('поставщик уже списал код до падения', Boolean(reserved), reserved);
  check('ключ израсходован ровно один', beforeKill.body.keys_consumed === 1, beforeKill.body.keys_consumed);
  check('покупателю ещё ничего не выдано', beforeKill.body.deliveries_count === 0, beforeKill.body.deliveries_count);

  section('SIGKILL процессу прямо посреди выдачи');
  server.kill('SIGKILL');
  await sleep(700);
  let alive = true;
  try {
    await call('GET', '/api/health');
  } catch {
    alive = false;
  }
  check('сервер действительно убит', alive === false);

  section('Перезапуск на той же БД, поставщик снова отвечает');
  server = startServer({ PROVIDER_A_TIMEOUT_RATE: '0', PROVIDER_A_FAIL_RATE: '0' });
  check('сервер поднялся заново', await waitHealthy());

  const afterCrash = await call('GET', `/api/orders/${orderId}`);
  check('заказ пережил падение и не потерялся', Boolean(afterCrash.body?.order), afterCrash.body?.order?.status);

  const recovered = await waitStatus(orderId, ['delivered'], 30000);
  check('сверка сама довела заказ до delivered', recovered?.status === 'delivered', recovered?.status);
  check('выдан тот же код, что был списан до падения', recovered?.delivery?.code === reserved,
    { reserved, delivered: recovered?.delivery?.code });

  const final = await admin('GET', `/api/admin/audit/${orderId}`);
  check('израсходован ровно один ключ', final.body.keys_consumed === 1, final.body.keys_consumed);
  check('ровно одна выдача', final.body.deliveries_count === 1, final.body.deliveries_count);

  const global = await admin('GET', '/api/admin/audit');
  check('глобальные инварианты целы', global.body.ok === true, global.body.totals);

  server.kill('SIGTERM');
  await sleep(300);
  finish();
  process.exit(process.exitCode ?? 0);
};

run();
