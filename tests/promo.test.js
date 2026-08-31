import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, db } from './helpers.js';
import { createOrder } from '../src/services/orders.js';
import { computeDiscount, findPromo, releasePromo } from '../src/services/promo.js';

test('скидка считается сервером от цены товара из БД', () => {
  resetDatabase();
  const percent = findPromo('LIMIT3');
  assert.equal(computeDiscount(percent, 129000), 32250);

  const amount = findPromo('GG500');
  assert.equal(computeDiscount(amount, 129000), 50000);
  // Скидка не может превысить стоимость заказа.
  assert.equal(computeDiscount(amount, 29900), 29900);
});

test('суммы из тела запроса игнорируются', () => {
  resetDatabase();
  const { order } = createOrder({
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

test('лимит использований соблюдается', () => {
  resetDatabase();
  const attempts = Array.from({ length: 10 }, (unused, index) => {
    try {
      createOrder({ sku: 'KEY-CS2-PRIME', promoCode: 'LIMIT3', idempotencyKey: `limit-${index}` });
      return 'ok';
    } catch (error) {
      return error.code;
    }
  });
  assert.equal(attempts.filter((item) => item === 'ok').length, 3);
  assert.equal(attempts.filter((item) => item === 'promo_exhausted').length, 7);
  assert.equal(db.prepare("SELECT used_count FROM promocodes WHERE code = 'LIMIT3'").get().used_count, 3);
});

test('отказ оплаты возвращает слот, повторный возврат ничего не делает', () => {
  resetDatabase();
  const { order } = createOrder({ sku: 'KEY-CS2-PRIME', promoCode: 'ONCEONLY', idempotencyKey: 'release-1' });
  assert.equal(db.prepare("SELECT used_count FROM promocodes WHERE code = 'ONCEONLY'").get().used_count, 1);

  assert.equal(releasePromo(order.id), true);
  assert.equal(db.prepare("SELECT used_count FROM promocodes WHERE code = 'ONCEONLY'").get().used_count, 0);
  assert.equal(releasePromo(order.id), false);
  assert.equal(db.prepare("SELECT used_count FROM promocodes WHERE code = 'ONCEONLY'").get().used_count, 0);
});
