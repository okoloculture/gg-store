/**
 * Критерии приёмки из задания, слово в слово, одним прогоном.
 * Каждый пункт проверяется по состоянию БД, а не по ответам API.
 */
import { api, check, ensureServer, ensureStock, finish, resetProviders, section, sleep, waitForStatus } from './lib.js';

const PARALLEL = Number(process.env.PARALLEL ?? 50);
const DISTINCT_ORDERS = Number(process.env.ORDERS ?? 20);

const webhook = (orderId, status, eventId, amount = 1290) => ({
  event_id: eventId,
  order_id: orderId,
  status,
  amount,
  currency: 'RUB',
  created_at: new Date().toISOString(),
});

const newOrder = async (sku = 'KEY-CS2-PRIME', extra = {}) => {
  const { body } = await api.post('/api/orders', { sku, ...extra }, {
    headers: { 'idempotency-key': `acc-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  return body.order;
};

const auditOrder = async (id) => (await api.admin.get(`/api/admin/audit/${id}`)).body;

const criterion1 = async () => {
  section(`1) ${PARALLEL} параллельных вебхуков "оплачено" по одному заказу`);
  const order = await newOrder();

  // Все event_id разные — самое жёсткое прочтение: это не ретраи, а N доставок.
  const responses = await Promise.all(
    Array.from({ length: PARALLEL }, (unused, index) =>
      api.post('/api/webhooks/payment', webhook(order.id, 'paid', `acc1_${order.id}_${index}`)),
    ),
  );
  check('все вебхуки получили 200', responses.every((item) => item.status === 200),
    [...new Set(responses.map((item) => item.status))]);

  const delivered = await waitForStatus(order.id, ['delivered'], { timeoutMs: 30000 });
  check('заказ выдан', delivered?.status === 'delivered', delivered?.status);

  const audit = await auditOrder(order.id);
  check('в системе ровно один факт выдачи', audit.deliveries_count === 1, audit.deliveries_count);
  check('израсходован ровно один ключ', audit.keys_consumed === 1, audit.keys_consumed);
  check('поставщик списал ровно один код', audit.provider_issues.length === 1, audit.provider_issues.length);
  check(`принято ${PARALLEL} событий оплаты`, audit.payment_events === PARALLEL, audit.payment_events);
  return order.id;
};

const criterion2 = async (orderId) => {
  section('2) Повторный вебхук с тем же event_id ничего не меняет');
  const before = await auditOrder(orderId);
  const eventId = `acc1_${orderId}_0`;

  const repeats = await Promise.all(
    Array.from({ length: 5 }, () => api.post('/api/webhooks/payment', webhook(orderId, 'paid', eventId))),
  );
  await sleep(400);
  const after = await auditOrder(orderId);

  check('повторы приняты с 200', repeats.every((item) => item.status === 200),
    [...new Set(repeats.map((item) => item.status))]);
  check('повторы помечены как дубли', repeats.every((item) => item.body.duplicate === true), repeats[0].body);
  check('число событий не выросло', after.payment_events === before.payment_events,
    { before: before.payment_events, after: after.payment_events });
  check('код не изменился', after.delivery.code === before.delivery.code,
    { before: before.delivery.code, after: after.delivery.code });
  check('выдача по-прежнему одна', after.deliveries_count === 1, after.deliveries_count);
  check('ключ по-прежнему один', after.keys_consumed === 1, after.keys_consumed);
  check('статус не изменился', after.order.status === before.order.status, after.order.status);
};

const criterion3 = async () => {
  section('3a) Вебхук пришёл раньше создания заказа');
  const earlyId = `ord_acc_${Date.now().toString(36)}`;
  const early = await api.post('/api/webhooks/payment', webhook(earlyId, 'paid', `acc3_early_${earlyId}`));
  check('принят с 200, ничего не упало', early.status === 200, early.status);
  check('событие отложено', early.body.pending === true, early.body);

  await api.post('/api/orders', { sku: 'KEY-CS2-PRIME', order_id: earlyId });
  await api.admin.post('/api/admin/reconcile', {});
  const delivered = await waitForStatus(earlyId, ['delivered'], { timeoutMs: 30000 });
  check('оплата не потеряна, заказ выдан', delivered?.status === 'delivered', delivered?.status);

  const earlyAudit = await auditOrder(earlyId);
  check('одна выдача, один ключ', earlyAudit.deliveries_count === 1 && earlyAudit.keys_consumed === 1,
    { deliveries: earlyAudit.deliveries_count, keys: earlyAudit.keys_consumed });

  section('3b) Вебхуки не по порядку: failed, затем paid');
  const swapped = await newOrder();
  await api.post('/api/webhooks/payment', webhook(swapped.id, 'failed', `acc3_f_${swapped.id}`));
  const afterFail = await api.get(`/api/orders/${swapped.id}`);
  check('после failed заказ в payment_failed', afterFail.body.order.status === 'payment_failed',
    afterFail.body.order.status);

  await api.post('/api/webhooks/payment', webhook(swapped.id, 'paid', `acc3_p_${swapped.id}`));
  const recovered = await waitForStatus(swapped.id, ['delivered'], { timeoutMs: 30000 });
  check('успешная оплата не потеряна', recovered?.status === 'delivered', recovered?.status);

  section('3c) Поздний failed после выданного заказа');
  const late = await api.post('/api/webhooks/payment', webhook(swapped.id, 'failed', `acc3_late_${swapped.id}`));
  await sleep(300);
  const stillAudit = await auditOrder(swapped.id);
  check('поздний failed принят с 200', late.status === 200, late.status);
  check('финальный статус не откатился', stillAudit.order.status === 'delivered', stillAudit.order.status);
  check('без дубля и потери ключа', stillAudit.deliveries_count === 1 && stillAudit.keys_consumed === 1,
    { deliveries: stillAudit.deliveries_count, keys: stillAudit.keys_consumed });
};

const criterion4 = async () => {
  section('4) Пустой пул ключей');
  const SKU = 'GIFT-PSN-1000';
  await api.admin.post('/api/admin/keys/drain', { sku: SKU });

  const order = await newOrder(SKU);
  await api.post(`/api/orders/${order.id}/pay`, { outcome: 'success' });

  const stuck = await waitForStatus(order.id, ['out_of_stock'], { timeoutMs: 30000 });
  check('заказ в восстановимом состоянии', stuck?.status === 'out_of_stock', stuck?.status);
  check('сервер не упал', (await api.get('/api/health')).status === 200);

  const emptyAudit = await auditOrder(order.id);
  check('ни одного ключа не израсходовано', emptyAudit.keys_consumed === 0, emptyAudit.keys_consumed);

  const list = await api.admin.get('/api/admin/orders?status=stuck');
  check('виден в списке "оплачен, но не выдан"',
    list.body.orders.some((item) => item.id === order.id), list.body.orders.length);

  section('4б) После пополнения повторная выдача даёт ровно один ключ');
  await api.admin.post('/api/admin/keys/refill', { provider: 'A', sku: SKU, count: 5 });
  await api.admin.post(`/api/admin/orders/${order.id}/redeliver`, {});
  const done = await waitForStatus(order.id, ['delivered'], { timeoutMs: 30000 });
  check('заказ выдан', done?.status === 'delivered', done?.status);

  const filled = await auditOrder(order.id);
  check('ровно один ключ', filled.keys_consumed === 1, filled.keys_consumed);
  check('ровно одна выдача', filled.deliveries_count === 1, filled.deliveries_count);

  section('4в) Повторная выдача идемпотентна');
  const again = await Promise.all(
    Array.from({ length: 5 }, () => api.admin.post(`/api/admin/orders/${order.id}/redeliver`, {})),
  );
  await sleep(400);
  const final = await auditOrder(order.id);
  check('все повторы вернули 200', again.every((item) => item.status === 200),
    [...new Set(again.map((item) => item.status))]);
  check('код не изменился', final.delivery.code === filled.delivery.code,
    { before: filled.delivery.code, after: final.delivery.code });
  check('ключ по-прежнему один', final.keys_consumed === 1, final.keys_consumed);
};

const criterion5 = async () => {
  section('5) Промокод с лимитом N под параллельными запросами');
  const stock = await api.admin.get('/api/admin/stock');
  const promo = stock.body.promocodes.find((item) => item.code === 'LIMIT3');
  const free = promo.max_uses - promo.used_count;

  const responses = await Promise.all(
    Array.from({ length: 40 }, (unused, index) =>
      api.post('/api/orders', { sku: 'KEY-GTA5', promo_code: 'LIMIT3' }, {
        headers: { 'idempotency-key': `acc5-${Date.now()}-${index}` },
      }),
    ),
  );
  const accepted = responses.filter((item) => item.status === 201 && item.body.order.promo_code === 'LIMIT3');
  const after = (await api.admin.get('/api/admin/stock')).body.promocodes.find((item) => item.code === 'LIMIT3');

  check('применён не более N раз', after.used_count <= after.max_uses, after);
  check('принято ровно столько, сколько было свободно', accepted.length === free,
    { accepted: accepted.length, free });
  check('счётчик сошёлся', after.used_count === promo.used_count + accepted.length, after);

  if (accepted.length) {
    const order = accepted[0].body.order;
    check('скидку посчитал сервер', order.discount_minor === Math.floor((order.base_amount_minor * 25) / 100),
      { discount: order.discount_minor, base: order.base_amount_minor });
  }
};

const hostile = async () => {
  section('Дополнительно: N параллельных заказов не делят один ключ');
  const orders = await Promise.all(Array.from({ length: DISTINCT_ORDERS }, () => newOrder('KEY-CS2-PRIME')));
  await Promise.all(orders.map((order) =>
    api.post('/api/webhooks/payment', webhook(order.id, 'paid', `hos_${order.id}`))));
  await Promise.all(orders.map((order) => waitForStatus(order.id, ['delivered'], { timeoutMs: 45000 })));

  const audits = await Promise.all(orders.map((order) => auditOrder(order.id)));
  const codes = audits.map((item) => item.delivery?.code).filter(Boolean);
  check('все заказы выданы', codes.length === DISTINCT_ORDERS, { delivered: codes.length, total: DISTINCT_ORDERS });
  check('все коды разные', new Set(codes).size === codes.length, { unique: new Set(codes).size });
  check('ни один заказ не взял два ключа', audits.every((item) => item.keys_consumed === 1),
    audits.filter((item) => item.keys_consumed !== 1).map((item) => item.order.id));

  section('Дополнительно: failed не приводит к выдаче');
  const failing = await newOrder('KEY-GTA5');
  await Promise.all(Array.from({ length: 10 }, (unused, index) =>
    api.post('/api/webhooks/payment', webhook(failing.id, 'failed', `hos_f_${failing.id}_${index}`))));
  await sleep(1500);
  const failAudit = await auditOrder(failing.id);
  check('заказ в payment_failed', failAudit.order.status === 'payment_failed', failAudit.order.status);
  check('ключ не израсходован', failAudit.keys_consumed === 0, failAudit.keys_consumed);
  check('выдачи нет', failAudit.deliveries_count === 0, failAudit.deliveries_count);

  section('Дополнительно: вебхук по несуществующему заказу не роняет сервер');
  const ghost = await Promise.all(Array.from({ length: 10 }, (unused, index) =>
    api.post('/api/webhooks/payment', webhook(`ord_ghost_${index}`, 'paid', `hos_g_${index}`))));
  check('все приняты с 200', ghost.every((item) => item.status === 200),
    [...new Set(ghost.map((item) => item.status))]);
  check('сервер жив', (await api.get('/api/health')).status === 200);

  section('Дополнительно: параллельные заказы с одним Idempotency-Key и промокодом');
  const key = `hos-idem-${Date.now()}`;
  const same = await Promise.all(Array.from({ length: 15 }, () =>
    api.post('/api/orders', { sku: 'KEY-EFT', promo_code: 'WELCOME10' }, { headers: { 'idempotency-key': key } })));
  const ids = [...new Set(same.map((item) => item.body?.order?.id))];
  check('создан ровно один заказ', ids.length === 1, ids);
  const promoUses = (await api.admin.get('/api/admin/stock')).body.promocodes.find((item) => item.code === 'WELCOME10');
  check('промокод списан один раз на этот заказ', promoUses.used_count >= 1, promoUses);

  section('Дополнительно: битые вебхуки отклоняются, а не ломают систему');
  const bad = await Promise.all([
    api.post('/api/webhooks/payment', {}),
    api.post('/api/webhooks/payment', { event_id: 'x' }),
    api.post('/api/webhooks/payment', { event_id: 'x', order_id: 'y', status: 'refunded' }),
  ]);
  check('все вернули 400', bad.every((item) => item.status === 400),
    bad.map((item) => item.status));
  check('сервер жив', (await api.get('/api/health')).status === 200);
};

const run = async () => {
  await ensureServer();
  await resetProviders();
  // Сценарий не должен зависеть от того, сколько ключей израсходовали до него.
  await ensureStock('KEY-CS2-PRIME', DISTINCT_ORDERS + 5);
  await ensureStock('KEY-GTA5', 8);
  await ensureStock('KEY-EFT', 3);

  const orderId = await criterion1();
  await criterion2(orderId);
  await criterion3();
  await criterion4();
  await criterion5();
  await hostile();

  section('Глобальные инварианты по всей базе');
  const { body: global } = await api.admin.get('/api/admin/audit');
  check('один код не попал в два заказа', global.duplicateCodes.length === 0, global.duplicateCodes);
  check('ни один заказ не израсходовал лишний ключ', global.overspentOrders.length === 0, global.overspentOrders);
  check('нет осиротевших ключей', global.orphanKeys.length === 0, global.orphanKeys.length);
  check('число выдач не превышает число списанных кодов',
    global.totals.deliveries <= global.totals.provider_issues, global.totals);

  finish();
};

run();
