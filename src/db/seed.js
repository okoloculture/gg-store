import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, inTransaction, migrate } from './index.js';
import { logger } from '../lib/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(fs.readFileSync(path.join(here, 'catalog.json'), 'utf8'));

/**
 * Раскладка пула по поставщикам. Пулы у A и B независимые: если у A ключи
 * кончились, переход на B имеет смысл. Пулы у не-key товаров намеренно
 * маленькие, чтобы сценарий out_of_stock воспроизводился без подготовки.
 */
const POOL_PLAN = {
  'KEY-CS2-PRIME': { A: 18, B: 8 },
  'KEY-GTA5': { A: 8, B: 4 },
  'KEY-EFT': { A: 8, B: 4 },
};
const GENERATED_POOL = { A: 6, B: 3 };

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const generatedCode = (sku, index) => {
  // Детерминированный псевдокод, чтобы повторный сид не плодил дубли.
  let hash = 2166136261;
  for (const ch of `${sku}:${index}`) {
    hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  }
  const group = () => {
    let out = '';
    for (let i = 0; i < 4; i += 1) {
      hash = Math.imul(hash ^ (hash >>> 13), 2246822519) >>> 0;
      out += alphabet[hash % alphabet.length];
    }
    return out;
  };
  return `${group()}-${group()}-${group()}`;
};

const buildPool = () => {
  const pool = [];
  const supplied = [...source.keys];
  let cursor = 0;

  for (const [sku, plan] of Object.entries(POOL_PLAN)) {
    for (const [provider, count] of Object.entries(plan)) {
      for (let i = 0; i < count; i += 1) {
        const code = supplied[cursor];
        cursor += 1;
        if (code) pool.push({ provider, sku, code });
      }
    }
  }

  for (const product of source.products) {
    if (POOL_PLAN[product.sku]) continue;
    for (const [provider, count] of Object.entries(GENERATED_POOL)) {
      for (let i = 0; i < count; i += 1) {
        pool.push({ provider, sku: product.sku, code: generatedCode(`${product.sku}${provider}`, i) });
      }
    }
  }
  return pool;
};

export const seed = ({ reset = false } = {}) => {
  migrate();

  inTransaction(() => {
    if (reset) {
      for (const table of ['deliveries', 'promo_redemptions', 'payment_events', 'orders', 'provider_issues', 'provider_keys', 'promocodes', 'products']) {
        db.exec(`DELETE FROM ${table}`);
      }
    }

    const insertProduct = db.prepare(
      `INSERT INTO products (sku, name, type, price_minor, currency, image, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sku) DO UPDATE SET
         name = excluded.name, type = excluded.type, price_minor = excluded.price_minor,
         currency = excluded.currency, image = excluded.image, position = excluded.position`,
    );
    source.products.forEach((product, index) => {
      insertProduct.run(product.sku, product.name, product.type, product.price * 100, product.currency, product.image, index);
    });

    const insertPromo = db.prepare(
      `INSERT INTO promocodes (code, type, value, currency, max_uses, used_count)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(code) DO UPDATE SET
         type = excluded.type, value = excluded.value, currency = excluded.currency,
         max_uses = excluded.max_uses`,
    );
    for (const promo of source.promocodes) {
      const value = promo.type === 'amount' ? promo.value * 100 : promo.value;
      insertPromo.run(promo.code, promo.type, value, promo.currency ?? null, promo.max_uses);
    }

    const insertKey = db.prepare(
      'INSERT OR IGNORE INTO provider_keys (provider, sku, code) VALUES (?, ?, ?)',
    );
    let added = 0;
    for (const item of buildPool()) {
      added += insertKey.run(item.provider, item.sku, item.code).changes;
    }
    logger.info('seed завершён', {
      products: source.products.length,
      promocodes: source.promocodes.length,
      keysAdded: added,
      reset,
    });
  });
};

if (import.meta.url === `file://${process.argv[1]}`) {
  seed({ reset: process.argv.includes('--reset') });
}
