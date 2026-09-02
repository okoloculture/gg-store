import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Драйвер подключается динамически: в режиме sqlite пакет pg не загружается,
 * поэтому локальный запуск и тесты по-прежнему не требуют ни одной установки.
 */
const buildDriver = async () => {
  if (config.dbDriver === 'postgres') {
    if (!config.databaseUrl) {
      throw new Error('Не задан DATABASE_URL: без него postgres-драйверу некуда подключаться');
    }
    const { createPostgresDriver } = await import('./drivers/postgres.js');
    return createPostgresDriver({
      connectionString: config.databaseUrl,
      maxConnections: config.pgMaxConnections,
      statementTimeoutMs: config.pgStatementTimeoutMs,
    });
  }
  const { createSqliteDriver } = await import('./drivers/sqlite.js');
  return createSqliteDriver({ dbPath: config.dbPath });
};

const driver = await buildDriver();

// Внутри транзакции все запросы обязаны идти по её соединению. ALS переносит
// это соединение через цепочку await, поэтому сервисам не нужно протаскивать
// его параметром через каждый вызов.
const current = new AsyncLocalStorage();
const runner = () => current.getStore() ?? driver;

const isPostgres = driver.dialect === 'postgres';

export const sql = {
  dialect: driver.dialect,

  // SQLite сериализует транзакции целиком (BEGIN IMMEDIATE), Postgres — нет,
  // поэтому там, где логика читает строку и решает по ней, в Postgres нужна
  // явная блокировка строки. В SQLite эти фрагменты пустые.
  forUpdate: isPostgres ? ' FOR UPDATE' : '',
  skipLocked: isPostgres ? ' FOR UPDATE SKIP LOCKED' : '',
  get: (text, ...params) => runner().get(text, params),
  all: (text, ...params) => runner().all(text, params),
  run: (text, ...params) => runner().run(text, params),
  exec: (text) => runner().exec(text),

  /**
   * Вложенный вызов присоединяется к внешней транзакции, а не открывает свою:
   * заказ и слот промокода обязаны фиксироваться одним COMMIT.
   */
  transaction: (fn) => {
    if (current.getStore()) return fn();
    return driver.transaction((connection) => current.run(connection, fn));
  },

  close: () => driver.close(),
};

export const migrate = async () => {
  const file = driver.dialect === 'postgres' ? 'schema.postgres.sql' : 'schema.sqlite.sql';
  await driver.exec(fs.readFileSync(path.join(here, file), 'utf8'));
};

/**
 * Нарушение UNIQUE — штатный исход гонки, а не сбой: проигравший вставку
 * должен вернуть уже созданную строку. Движки сообщают об этом по-разному,
 * поэтому проверка вынесена сюда.
 */
export const isUniqueViolation = (error, table, column) => {
  const target = driver.uniqueTarget(error);
  if (!target) return false;
  return target.includes(table) && target.includes(column);
};
