import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, db } from './helpers.js';
import { createOrder, getOrderRow } from '../src/services/orders.js';
import { parseWebhook, receiveWebhook } from '../src/services/payments.js';

const webhook = (orderId, status, eventId) =>
  parseWebhook({ event_id: eventId, order_id: orderId, status, amount: 1290, currency: 'RUB' });

test('повтор события с тем же event_id не применяется дважды', () => {
  resetDatabase();
  const { order } = createOrder({ sku: 'KEY-CS2-PRIME', idempotencyKey: 'dup-1' });

  const first = receiveWebhook(webhook(order.id, 'paid', 'evt_1'));
  const second = receiveWebhook(webhook(order.id, 'paid', 'evt_1'));

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_events WHERE order_id = ?').get(order.id).n, 1);
});

test('успешная оплата не теряется при обратном порядке событий', () => {
  resetDatabase();
  const { order } = createOrder({ sku: 'KEY-CS2-PRIME', idempotencyKey: 'order-1' });

  receiveWebhook(webhook(order.id, 'failed', 'evt_failed'));
  assert.equal(getOrderRow(order.id).status, 'payment_failed');

  receiveWebhook(webhook(order.id, 'paid', 'evt_paid'));
  assert.equal(getOrderRow(order.id).status, 'paid');
});

test('поздний failed не откатывает финальный статус', () => {
  resetDatabase();
  const { order } = createOrder({ sku: 'KEY-CS2-PRIME', idempotencyKey: 'order-2' });

  receiveWebhook(webhook(order.id, 'paid', 'evt_paid_2'));
  db.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(order.id);

  receiveWebhook(webhook(order.id, 'failed', 'evt_failed_2'));
  assert.equal(getOrderRow(order.id).status, 'delivered');
});

test('вебхук раньше заказа сохраняется и применяется позже', () => {
  resetDatabase();
  const orderId = 'ord_before_order';

  const early = receiveWebhook(webhook(orderId, 'paid', 'evt_early'));
  assert.equal(early.orderExists, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_events WHERE applied_at IS NULL').get().n, 1);

  createOrder({ sku: 'KEY-CS2-PRIME', orderId, idempotencyKey: 'early-1' });
  const applied = receiveWebhook(webhook(orderId, 'paid', 'evt_early_2'));
  assert.equal(applied.status, 'paid');
});

test('невалидный вебхук отклоняется', () => {
  resetDatabase();
  assert.throws(() => parseWebhook({ order_id: 'x', status: 'paid' }), /event_id/);
  assert.throws(() => parseWebhook({ event_id: 'e', order_id: 'x', status: 'refunded' }), /paid или failed/);
});
