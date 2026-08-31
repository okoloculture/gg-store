/**
 * Критерий приёмки 3: вебхук пришёл раньше создания заказа и не по порядку.
 * Ожидание: ничего не потеряно и не задвоено.
 */
import { api, check, ensureServer, ensureStock, finish, resetProviders, section, waitForStatus } from './lib.js';

const webhook = (orderId, status, eventId, amount) => ({
  event_id: eventId,
  order_id: orderId,
  status,
  amount,
  currency: 'RUB',
  created_at: new Date().toISOString(),
});

const run = async () => {
  await ensureServer();
  await resetProviders();
  await ensureStock('KEY-CS2-PRIME', 5);

  section('Вебхук приходит раньше создания заказа');
  const earlyId = `ord_early_${Date.now().toString(36)}`;

  const early = await api.post('/api/webhooks/payment', webhook(earlyId, 'paid', `evt_early_${earlyId}`, 1290));
  check('ранний вебхук принят с 200', early.status === 200, early.status);
  check('событие отложено до появления заказа', early.body.pending === true, early.body);

  const created = await api.post('/api/orders', { sku: 'KEY-CS2-PRIME', order_id: earlyId });
  check('заказ создан с заданным id', created.body?.order?.id === earlyId, created.body?.order?.id);

  // Сверка подхватит отложенное событие; ускоряем её вручную.
  await api.admin.post('/api/admin/reconcile', {});
  const delivered = await waitForStatus(earlyId, ['delivered']);
  check('оплата не потеряна, заказ выдан', delivered?.status === 'delivered', delivered?.status);

  const { body: earlyAudit } = await api.admin.get(`/api/admin/audit/${earlyId}`);
  check('одна выдача', earlyAudit.deliveries_count === 1, earlyAudit.deliveries_count);
  check('один ключ', earlyAudit.keys_consumed === 1, earlyAudit.keys_consumed);

  section('События приходят в обратном порядке: failed, затем paid');
  const swapped = await api.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  const swappedId = swapped.body.order.id;

  await api.post('/api/webhooks/payment', webhook(swappedId, 'failed', `evt_f_${swappedId}`, 1290));
  const afterFail = await api.get(`/api/orders/${swappedId}`);
  check('после failed заказ в payment_failed', afterFail.body.order.status === 'payment_failed',
    afterFail.body.order.status);

  await api.post('/api/webhooks/payment', webhook(swappedId, 'paid', `evt_p_${swappedId}`, 1290));
  const recovered = await waitForStatus(swappedId, ['delivered']);
  check('успешная оплата не потеряна и заказ выдан', recovered?.status === 'delivered', recovered?.status);

  const { body: swapAudit } = await api.admin.get(`/api/admin/audit/${swappedId}`);
  check('одна выдача', swapAudit.deliveries_count === 1, swapAudit.deliveries_count);
  check('один ключ', swapAudit.keys_consumed === 1, swapAudit.keys_consumed);

  section('Поздний failed после уже выданного заказа');
  const late = await api.post('/api/webhooks/payment', webhook(swappedId, 'failed', `evt_late_${swappedId}`, 1290));
  check('поздний failed принят с 200', late.status === 200, late.status);
  const stillDelivered = await api.get(`/api/orders/${swappedId}`);
  check('финальный статус не откатился', stillDelivered.body.order.status === 'delivered',
    stillDelivered.body.order.status);
  check('код не изменился', stillDelivered.body.order.delivery.code === swapAudit.delivery.code, {
    before: swapAudit.delivery.code, after: stillDelivered.body.order.delivery.code,
  });

  const { body: global } = await api.admin.get('/api/admin/audit');
  check('глобальные инварианты целы', global.ok === true, global.totals);

  finish();
};

run();
