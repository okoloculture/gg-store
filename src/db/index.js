import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

// WAL + busy_timeout: параллельные писатели ждут блокировку, а не падают с SQLITE_BUSY.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 10000');

export const migrate = () => {
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
};

/**
 * BEGIN IMMEDIATE берёт write-блокировку сразу, а не при первой записи.
 * Это убирает окно "read -> decide -> write", в котором два процесса могли бы
 * прочитать одно и то же состояние и оба решить, что имеют право выдать ключ.
 */
export const inTransaction = (fn) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
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
};

export const changes = () => Number(db.prepare('SELECT changes() AS n').get().n);

migrate();
