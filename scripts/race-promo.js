/**
 * Критерий приёмки 5: промокод с лимитом N под параллельными запросами.
 * Ожидание: применён не более N раз, скидку считает сервер.
 */
import { api, check, ensureServer, ensureStock, finish, resetProviders, section } from './lib.js';

const PARALLEL = Number(process.env.PARALLEL ?? 40);

const usedCount = async (code) => {
  const { body } = await api.admin.get('/api/admin/stock');
  return body.promocodes.find((item) => item.code === code);
};

const run = async () => {
  await ensureServer();
  await resetProviders();
  await ensureStock('KEY-CS2-PRIME', 3);

  section(`Промокод LIMIT3 (max_uses = 3) под ${PARALLEL} параллельными запросами`);
  const promoBefore = await usedCount('LIMIT3');
  const remaining = promoBefore.max_uses - promoBefore.used_count;

  const responses = await Promise.all(
    Array.from({ length: PARALLEL }, (unused, index) =>
      api.post('/api/orders', { sku: 'KEY-CS2-PRIME', promo_code: 'limit3' }, {
        headers: { 'idempotency-key': `promo-${Date.now()}-${index}` },
      }),
    ),
  );

  const accepted = responses.filter((item) => item.status === 201 && item.body.order.promo_code === 'LIMIT3');
  const rejected = responses.filter((item) => item.body?.error?.code === 'promo_exhausted');

  check('промокод применён не больше, чем осталось слотов', accepted.length <= remaining, {
    accepted: accepted.length, remaining,
  });
  check('остальные запросы получили явный отказ', accepted.length + rejected.length === PARALLEL, {
    accepted: accepted.length, rejected: rejected.length, total: PARALLEL,
  });

  const promoAfter = await usedCount('LIMIT3');
  check('used_count не превысил max_uses', promoAfter.used_count <= promoAfter.max_uses, promoAfter);
  check('счётчик совпал с числом принятых заказов',
    promoAfter.used_count === promoBefore.used_count + accepted.length, {
      before: promoBefore.used_count, after: promoAfter.used_count, accepted: accepted.length,
    });

  section('Скидку считает сервер');
  if (accepted.length) {
    const order = accepted[0].body.order;
    const expected = Math.floor((order.base_amount_minor * 25) / 100);
    check('скидка 25% посчитана на сервере', order.discount_minor === expected, {
      discount: order.discount_minor, expected,
    });
    check('итог = база минус скидка', order.amount_minor === order.base_amount_minor - order.discount_minor, {
      base: order.base_amount_minor, discount: order.discount_minor, total: order.amount_minor,
    });
  }

  const spoofed = await api.post('/api/orders', {
    sku: 'KEY-CS2-PRIME',
    promo_code: 'WELCOME10',
    amount: 1,
    amount_minor: 1,
    discount_minor: 128999,
    price: 1,
  }, { headers: { 'idempotency-key': `spoof-${Date.now()}` } });
  const spoofedOrder = spoofed.body.order;
  check('подделанные суммы из клиента игнорируются',
    spoofedOrder.base_amount_minor === 129000 && spoofedOrder.discount_minor === 12900
      && spoofedOrder.amount_minor === 116100,
    {
      base: spoofedOrder.base_amount_minor,
      discount: spoofedOrder.discount_minor,
      total: spoofedOrder.amount_minor,
    });

  section('Промокод ONCEONLY (max_uses = 1)');
  const onceBefore = await usedCount('ONCEONLY');
  const onceResponses = await Promise.all(
    Array.from({ length: 20 }, (unused, index) =>
      api.post('/api/orders', { sku: 'KEY-GTA5', promo_code: 'ONCEONLY' }, {
        headers: { 'idempotency-key': `once-${Date.now()}-${index}` },
      }),
    ),
  );
  const onceAccepted = onceResponses.filter((item) => item.status === 201);
  const onceAfter = await usedCount('ONCEONLY');
  check('применён не более одного раза', onceAfter.used_count <= 1, onceAfter);
  check('принято ровно столько, сколько было свободных слотов',
    onceAccepted.length === onceBefore.max_uses - onceBefore.used_count,
    { accepted: onceAccepted.length, free: onceBefore.max_uses - onceBefore.used_count });

  finish();
};

run();
