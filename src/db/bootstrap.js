import { sql, migrate } from './index.js';
import { seed } from './seed.js';
import { logger } from '../lib/logger.js';

let ready = null;

/**
 * Подготовка БД на serverless: схемы и каталога там некому создать заранее,
 * а инстанс поднимается на пустом окружении. Выполняется один раз на инстанс,
 * повторные вызовы ждут тот же промис.
 *
 * Сид идемпотентен (ON CONFLICT / INSERT OR IGNORE), поэтому одновременный
 * холодный старт нескольких инстансов не создаёт дублей.
 */
export const ensureReady = () => {
  ready ??= (async () => {
    await migrate();
    const products = await sql.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM products');
    if (products.n === 0) {
      logger.info('пустая база, выполняется первичный сид');
      await seed();
    }
  })().catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
};
