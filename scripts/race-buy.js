/**
 * Двойной (и N-кратный) клик по кнопке "Купить".
 * Ожидание: один заказ на один Idempotency-Key, один ключ.
 */
import { api, check, ensureServer, finish, resetProviders, section, waitForStatus } from './lib.js';

const CLICKS = Number(process.env.CLICKS ?? 10);

const run = async () => {
  await ensureServer();
  await resetProviders();

  section(`${CLICKS} одновременных кликов "Купить" с одним Idempotency-Key`);
  const key = `buy-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const responses = await Promise.all(
    Array.from({ length: CLICKS }, () =>
      api.post('/api/orders', { sku: 'KEY-GTA5' }, { headers: { 'idempotency-key': key } }),
    ),
  );

  const ids = [...new Set(responses.map((item) => item.body?.order?.id))];
  check('все ответы успешны', responses.every((item) => item.status === 200 || item.status === 201),
    [...new Set(responses.map((item) => item.status))]);
  check('создан ровно один заказ', ids.length === 1, ids);

  const orderId = ids[0];

  section(`${CLICKS} одновременных оплат одного заказа`);
  const payments = await Promise.all(
    Array.from({ length: CLICKS }, () => api.post(`/api/orders/${orderId}/pay`, { outcome: 'success' })),
  );
  check('все запросы оплаты получили 200', payments.every((item) => item.status === 200),
    [...new Set(payments.map((item) => item.status))]);

  const delivered = await waitForStatus(orderId, ['delivered']);
  check('заказ выдан', delivered?.status === 'delivered', delivered?.status);

  const { body: audit } = await api.admin.get(`/api/admin/audit/${orderId}`);
  check('одна выдача', audit.deliveries_count === 1, audit.deliveries_count);
  check('один ключ', audit.keys_consumed === 1, audit.keys_consumed);

  const { body: global } = await api.admin.get('/api/admin/audit');
  check('глобальные инварианты целы', global.ok === true, global.totals);

  finish();
};

run();
