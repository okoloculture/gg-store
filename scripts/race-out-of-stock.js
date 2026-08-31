/**
 * Критерий приёмки 4: пустой пул -> восстановимое состояние без падения,
 * после пополнения повторная выдача даёт ровно один ключ, повтор идемпотентен.
 */
import { api, check, ensureServer, finish, resetProviders, section, sleep, waitForStatus } from './lib.js';

const SKU = 'GIFT-XBOX-1500';

const run = async () => {
  await ensureServer();
  await resetProviders();

  section('Пул пуст в момент выдачи');
  await api.admin.post('/api/admin/keys/drain', { sku: SKU });

  const created = await api.post('/api/orders', { sku: SKU });
  const orderId = created.body.order.id;
  const pay = await api.post(`/api/orders/${orderId}/pay`, { outcome: 'success' });
  check('оплата обработана без ошибки', pay.status === 200, pay.status);

  const stuck = await waitForStatus(orderId, ['out_of_stock'], { timeoutMs: 25000 });
  check('заказ в восстановимом состоянии out_of_stock', stuck?.status === 'out_of_stock', stuck?.status);
  check('сервер не упал', (await api.get('/api/health')).status === 200);

  const { body: stuckList } = await api.admin.get('/api/admin/orders?status=stuck');
  check('заказ виден в админке "оплачен, но не выдан"',
    stuckList.orders.some((item) => item.id === orderId), stuckList.orders.length);

  const { body: emptyAudit } = await api.admin.get(`/api/admin/audit/${orderId}`);
  check('ни одного ключа не израсходовано', emptyAudit.keys_consumed === 0, emptyAudit.keys_consumed);

  section('Пополнение пула и ручная повторная выдача');
  const refill = await api.admin.post('/api/admin/keys/refill', { provider: 'A', sku: SKU, count: 3 });
  check('пул пополнен', refill.body.added === 3, refill.body.added);

  const redelivered = await api.admin.post(`/api/admin/orders/${orderId}/redeliver`, {});
  check('повторная выдача успешна', redelivered.body.delivered === true, redelivered.body.order?.status);

  const done = await waitForStatus(orderId, ['delivered']);
  check('заказ выдан', done?.status === 'delivered', done?.status);
  check('код получен', Boolean(done?.delivery?.code), done?.delivery?.code);

  section('Повторная выдача идемпотентна');
  const first = done.delivery.code;
  const again = await Promise.all([
    api.admin.post(`/api/admin/orders/${orderId}/redeliver`, {}),
    api.admin.post(`/api/admin/orders/${orderId}/redeliver`, {}),
    api.admin.post(`/api/admin/orders/${orderId}/redeliver`, {}),
  ]);
  check('все повторы вернули 200', again.every((item) => item.status === 200),
    [...new Set(again.map((item) => item.status))]);

  await sleep(300);
  const { body: finalAudit } = await api.admin.get(`/api/admin/audit/${orderId}`);
  check('код не изменился', finalAudit.delivery.code === first, { before: first, after: finalAudit.delivery.code });
  check('выдача одна', finalAudit.deliveries_count === 1, finalAudit.deliveries_count);
  check('израсходован ровно один ключ', finalAudit.keys_consumed === 1, finalAudit.keys_consumed);

  section('Оба поставщика падают: delivery_failed, затем восстановление');
  await api.admin.post('/api/admin/providers/config', { A: { forced: 'error' }, B: { forced: 'error' } });
  const failing = await api.post('/api/orders', { sku: 'KEY-EFT' });
  const failingId = failing.body.order.id;
  await api.post(`/api/orders/${failingId}/pay`, { outcome: 'success' });

  const failed = await waitForStatus(failingId, ['delivery_failed'], { timeoutMs: 25000 });
  check('заказ в восстановимом состоянии delivery_failed', failed?.status === 'delivery_failed', failed?.status);

  await resetProviders();
  const recovered = await waitForStatus(failingId, ['delivered'], { timeoutMs: 25000 });
  check('после восстановления поставщика заказ выдан', recovered?.status === 'delivered', recovered?.status);

  const { body: recoveredAudit } = await api.admin.get(`/api/admin/audit/${failingId}`);
  check('израсходован ровно один ключ', recoveredAudit.keys_consumed === 1, recoveredAudit.keys_consumed);

  const { body: global } = await api.admin.get('/api/admin/audit');
  check('глобальные инварианты целы', global.ok === true, global.totals);

  finish();
};

run();
