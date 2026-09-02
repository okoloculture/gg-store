import { after } from 'node:test';
import { sql } from '../src/db/index.js';
import { seed, TABLES } from '../src/db/seed.js';

export const resetDatabase = async () => {
  await seed({ reset: true });
};

// Пул Postgres держит соединения открытыми и не даёт процессу завершиться.
after(() => sql.close());

export { sql, TABLES };
