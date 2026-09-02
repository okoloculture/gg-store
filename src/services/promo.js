import { sql } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

const normalize = (code) => String(code ?? '').trim().toUpperCase();

export const findPromo = (code) =>
  sql.get('SELECT * FROM promocodes WHERE code = ?', normalize(code));

/**
 * Скидка считается ТОЛЬКО на сервере и только от цены товара из БД.
 * Клиент передаёт лишь код промокода; сумма из клиента не используется нигде.
 */
export const computeDiscount = (promo, baseMinor) => {
  if (!promo) return 0;
  const raw = promo.type === 'percent'
    ? Math.floor((baseMinor * promo.value) / 100)
    : promo.value;
  return Math.max(0, Math.min(raw, baseMinor));
};

export const previewPromo = async (code, product) => {
  const promo = await findPromo(code);
  if (!promo) throw notFound('promo_not_found', 'Промокод не найден');
  if (promo.used_count >= promo.max_uses) {
    throw conflict('promo_exhausted', 'Лимит использований промокода исчерпан');
  }
  const discount = computeDiscount(promo, product.price_minor);
  return {
    code: promo.code,
    type: promo.type,
    discount_minor: discount,
    total_minor: product.price_minor - discount,
    uses_left: promo.max_uses - promo.used_count,
  };
};

/**
 * Занимает один слот использования. Вызывается ВНУТРИ той же транзакции,
 * что и создание заказа.
 *
 * Условный UPDATE `used_count < max_uses` атомарен на обоих движках: под
 * BEGIN IMMEDIATE в SQLite и за счёт перепроверки условия по новой версии
 * строки в Postgres. При N параллельных попытках ровно max_uses из них
 * получат changes = 1, остальные — 0 и откатятся. Проверка "хватает ли
 * лимита" и его расход происходят одной операцией, окна для гонки нет.
 */
export const reservePromo = async (code, orderId, baseMinor) => {
  const normalized = normalize(code);
  const promo = await sql.get('SELECT * FROM promocodes WHERE code = ?', normalized);
  if (!promo) throw notFound('promo_not_found', 'Промокод не найден');

  const claimed = await sql.run(
    'UPDATE promocodes SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses',
    normalized,
  );
  if (claimed !== 1) {
    throw conflict('promo_exhausted', 'Лимит использований промокода исчерпан');
  }

  const discount = computeDiscount(promo, baseMinor);
  await sql.run(
    'INSERT INTO promo_redemptions (order_id, code, discount_minor, created_at) VALUES (?, ?, ?, ?)',
    orderId, normalized, discount, new Date().toISOString(),
  );

  return { code: normalized, discount_minor: discount };
};

/**
 * Возврат слота, если оплата не прошла. Идемпотентен: released_at IS NULL
 * в условии не даёт вернуть один и тот же слот дважды.
 */
export const releasePromo = async (orderId) => {
  const redemption = await sql.get(
    'SELECT * FROM promo_redemptions WHERE order_id = ? AND released_at IS NULL', orderId,
  );
  if (!redemption) return false;

  const released = await sql.run(
    'UPDATE promo_redemptions SET released_at = ? WHERE order_id = ? AND released_at IS NULL',
    new Date().toISOString(), orderId,
  );
  if (released !== 1) return false;

  await sql.run(
    'UPDATE promocodes SET used_count = used_count - 1 WHERE code = ? AND used_count > 0',
    redemption.code,
  );
  return true;
};

export const promoStats = () =>
  sql.all('SELECT code, type, value, max_uses, used_count FROM promocodes ORDER BY code');

export const assertPromoInput = (code) => {
  if (code === undefined || code === null || code === '') return null;
  const normalized = normalize(code);
  if (!/^[A-Z0-9_-]{2,32}$/.test(normalized)) {
    throw badRequest('invalid_promo_code', 'Некорректный формат промокода');
  }
  return normalized;
};
