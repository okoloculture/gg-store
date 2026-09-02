import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Драйвер node:sqlite.
 *
 * node:sqlite синхронный и работает поверх одного соединения, поэтому весь
 * доступ сериализуется внутренней очередью: точка `await` внутри транзакции
 * иначе позволила бы чужому запросу выполниться между BEGIN и COMMIT.
 * Прежняя синхронная версия давала ровно такую же сериализацию через
 * BEGIN IMMEDIATE, семантика не меняется.
 */
const UNIQUE_RE = /UNIQUE constraint failed:\s*([^\s)]+)/;

export const createSqliteDriver = ({ dbPath }) => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 10000');

  let chain = Promise.resolve();
  const serialize = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.then(() => undefined, () => undefined);
    return next;
  };

  const rows = (text, params) => db.prepare(text).all(...params);
  const single = (text, params) => db.prepare(text).get(...params) ?? null;
  const changes = (text, params) => Number(db.prepare(text).run(...params).changes);

  const connection = {
    get: async (text, params) => single(text, params),
    all: async (text, params) => rows(text, params),
    run: async (text, params) => changes(text, params),
    exec: async (text) => db.exec(text),
  };

  return {
    dialect: 'sqlite',
    uniqueTarget: (error) => UNIQUE_RE.exec(error?.message ?? '')?.[1] ?? null,
    get: (text, params) => serialize(() => single(text, params)),
    all: (text, params) => serialize(() => rows(text, params)),
    run: (text, params) => serialize(() => changes(text, params)),
    exec: (text) => serialize(() => db.exec(text)),

    /**
     * BEGIN IMMEDIATE берёт write-блокировку сразу, а не при первой записи:
     * окна "прочитали -> подумали -> записали" не остаётся.
     */
    transaction: (fn) =>
      serialize(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(connection);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // транзакция уже откатилась
          }
          throw error;
        }
      }),

    close: async () => db.close(),
  };
};
