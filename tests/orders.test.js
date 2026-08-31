import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase } from './helpers.js';
import { createOrder, getOrder } from '../src/services/orders.js';

test('один Idempotency-Key даёт один заказ', () => {
  resetDatabase();
  const first = createOrder({ sku: 'KEY-GTA5', idempotencyKey: 'double-click' });
  const second = createOrder({ sku: 'KEY-GTA5', idempotencyKey: 'double-click' });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.order.id, first.order.id);
});

test('неизвестный sku отклоняется', () => {
  resetDatabase();
  assert.throws(() => createOrder({ sku: 'NOPE', idempotencyKey: 'bad-sku' }), /Товар не найден/);
});

test('заказ создаётся в статусе created с ценой из каталога', () => {
  resetDatabase();
  const { order } = createOrder({ sku: 'KEY-EFT', idempotencyKey: 'fresh' });
  assert.equal(order.status, 'created');
  assert.equal(order.amount_minor, 349000);
  assert.equal(getOrder(order.id).id, order.id);
});
