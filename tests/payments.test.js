import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, sql } from './helpers.js';
import { createOrder, getOrderRow } from '../src/services/orders.js';
import { parseWebhook, receiveWebhook } from '../src/services/payments.js';

const webhook = (orderId, status, eventId) =>
  parseWebhook({ event_id: eventId, order_id: orderId, status, amount: 1290, currency: 'RUB' });

const countEvents = async (where, ...params) =>
  (await sql.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM payment_events WHERE ${where}`, ...params)).n;

test('повтор события с тем же event_id не применяется дважды', async () => {
  await resetDatabase();
  const { order } = await createOrder({ sku: 'KEY-CS2-PRIME', idempotencyKey: 'dup-1' });

  const first = await receiveWebhook(webhook(order.id, 'paid', 'evt_1'));
  const second = await receiveWebhook(webhook(order.id, 'paid', 'evt_1'));

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(await countEvents('order_id = ?', order.id), 1);
});

test('успешная оплата не теряется при обратном порядке событий', async () => {
  await resetDatabase();
  const { order } = await createOrder({ sku: 'KEY-CS2-PRIME', idempotencyKey: 'order-1' });

  await receiveWebhook(webhook(order.id, 'failed', 'evt_failed'));
  assert.equal((await getOrderRow(order.id)).status, 'payment_failed');

  await receiveWebhook(webhook(order.id, 'paid', 'evt_paid'));
  assert.equal((await getOrderRow(order.id)).status, 'paid');
});

test('поздний failed не откатывает финальный статус', async () => {
  await resetDatabase();
  const { order } = await createOrder({ sku: 'KEY-CS2-PRIME', idempotencyKey: 'order-2' });

  await receiveWebhook(webhook(order.id, 'paid', 'evt_paid_2'));
  await sql.run("UPDATE orders SET status = 'delivered' WHERE id = ?", order.id);

  await receiveWebhook(webhook(order.id, 'failed', 'evt_failed_2'));
  assert.equal((await getOrderRow(order.id)).status, 'delivered');
});

test('вебхук раньше заказа сохраняется и применяется позже', async () => {
  await resetDatabase();
  const orderId = 'ord_before_order';

  const early = await receiveWebhook(webhook(orderId, 'paid', 'evt_early'));
  assert.equal(early.orderExists, false);
  assert.equal(await countEvents('applied_at IS NULL'), 1);

  await createOrder({ sku: 'KEY-CS2-PRIME', orderId, idempotencyKey: 'early-1' });
  const applied = await receiveWebhook(webhook(orderId, 'paid', 'evt_early_2'));
  assert.equal(applied.status, 'paid');
});

test('невалидный вебхук отклоняется', async () => {
  await resetDatabase();
  assert.throws(() => parseWebhook({ order_id: 'x', status: 'paid' }), /event_id/);
  assert.throws(() => parseWebhook({ event_id: 'e', order_id: 'x', status: 'refunded' }), /paid или failed/);
});
