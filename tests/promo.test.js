import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, sql } from './helpers.js';
import { createOrder } from '../src/services/orders.js';
import { computeDiscount, findPromo, releasePromo } from '../src/services/promo.js';

const usedCount = async (code) =>
  (await sql.get('SELECT used_count FROM promocodes WHERE code = ?', code)).used_count;

test('скидка считается сервером от цены товара из БД', async () => {
  await resetDatabase();
  const percent = await findPromo('LIMIT3');
  assert.equal(computeDiscount(percent, 129000), 32250);

  const amount = await findPromo('GG500');
  assert.equal(computeDiscount(amount, 129000), 50000);
  // Скидка не может превысить стоимость заказа.
  assert.equal(computeDiscount(amount, 29900), 29900);
});

test('суммы из тела запроса игнорируются', async () => {
  await resetDatabase();
  const { order } = await createOrder({
    sku: 'KEY-CS2-PRIME',
    promoCode: 'WELCOME10',
    idempotencyKey: 'spoof-1',
    amount_minor: 1,
    discount_minor: 128999,
  });
  assert.equal(order.base_amount_minor, 129000);
  assert.equal(order.discount_minor, 12900);
  assert.equal(order.amount_minor, 116100);
});

test('лимит использований соблюдается', async () => {
  await resetDatabase();
  const attempts = [];
  for (let index = 0; index < 10; index += 1) {
    try {
      await createOrder({ sku: 'KEY-CS2-PRIME', promoCode: 'LIMIT3', idempotencyKey: `limit-${index}` });
      attempts.push('ok');
    } catch (error) {
      attempts.push(error.code);
    }
  }
  assert.equal(attempts.filter((item) => item === 'ok').length, 3);
  assert.equal(attempts.filter((item) => item === 'promo_exhausted').length, 7);
  assert.equal(await usedCount('LIMIT3'), 3);
});

test('отказ оплаты возвращает слот, повторный возврат ничего не делает', async () => {
  await resetDatabase();
  const { order } = await createOrder({ sku: 'KEY-CS2-PRIME', promoCode: 'ONCEONLY', idempotencyKey: 'release-1' });
  assert.equal(await usedCount('ONCEONLY'), 1);

  assert.equal(await releasePromo(order.id), true);
  assert.equal(await usedCount('ONCEONLY'), 0);
  assert.equal(await releasePromo(order.id), false);
  assert.equal(await usedCount('ONCEONLY'), 0);
});
