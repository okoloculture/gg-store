/**
 * Критерии приёмки 1 и 2.
 * 50 параллельных вебхуков "оплачено" по одному заказу + повтор того же event_id.
 * Ожидание: ровно один факт выдачи, ровно один израсходованный ключ.
 */
import { api, check, createOrder, ensureServer, finish, resetProviders, section, waitForStatus } from './lib.js';

const PARALLEL = Number(process.env.PARALLEL ?? 50);

const run = async () => {
  await ensureServer();
  await resetProviders();

  section(`${PARALLEL} параллельных вебхуков по одному заказу`);
  const order = await createOrder('KEY-CS2-PRIME');

  const payload = (eventId) => ({
    event_id: eventId,
    order_id: order.id,
    status: 'paid',
    amount: order.amount,
    currency: order.currency,
    created_at: new Date().toISOString(),
  });

  // Половина запросов — один и тот же event_id (ретраи платёжки),
  // половина — уникальные event_id (несколько независимых доставок).
  const responses = await Promise.all(
    Array.from({ length: PARALLEL }, (unused, index) =>
      api.post('/api/webhooks/payment', payload(index % 2 === 0 ? `evt_same_${order.id}` : `evt_${order.id}_${index}`)),
    ),
  );

  check('все вебхуки получили 200', responses.every((item) => item.status === 200), {
    statuses: [...new Set(responses.map((item) => item.status))],
  });

  const delivered = await waitForStatus(order.id, ['delivered']);
  check('заказ в статусе delivered', delivered?.status === 'delivered', { status: delivered?.status });

  const { body: before } = await api.admin.get(`/api/admin/audit/${order.id}`);
  check('ровно одна запись о выдаче', before.deliveries_count === 1, before.deliveries_count);
  check('израсходован ровно один ключ', before.keys_consumed === 1, before.keys_consumed);
  check('поставщик списал ровно один код', before.provider_issues.length === 1, before.provider_issues.length);
  check('код заказа совпадает с кодом поставщика',
    before.delivery?.code === before.provider_issues[0]?.code,
    { order: before.delivery?.code, provider: before.provider_issues[0]?.code });
  check('получено больше одного события оплаты', before.payment_events > 1, before.payment_events);

  section('Повторный вебхук с тем же event_id ничего не меняет');
  const repeat = await api.post('/api/webhooks/payment', payload(`evt_same_${order.id}`));
  check('повтор принят с 200', repeat.status === 200, repeat.status);
  check('повтор распознан как дубль', repeat.body.duplicate === true, repeat.body);

  const { body: after } = await api.admin.get(`/api/admin/audit/${order.id}`);
  check('код не изменился', after.delivery.code === before.delivery.code, {
    before: before.delivery.code, after: after.delivery.code,
  });
  check('выдача по-прежнему одна', after.deliveries_count === 1, after.deliveries_count);
  check('ключ по-прежнему один', after.keys_consumed === 1, after.keys_consumed);

  const { body: global } = await api.admin.get('/api/admin/audit');
  check('глобальные инварианты целы', global.ok === true, {
    duplicateCodes: global.duplicateCodes.length,
    overspentOrders: global.overspentOrders.length,
    orphanKeys: global.orphanKeys.length,
  });

  finish();
};

run();
