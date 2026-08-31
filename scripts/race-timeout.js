/**
 * Ловушка таймаута: поставщик успел списать код, но ответ не дошёл.
 * Ожидание: повтор с тем же request_id возвращает тот же код,
 * второй ключ не расходуется, заказ доводится до delivered.
 */
import { api, check, ensureServer, finish, resetProviders, section, waitForStatus } from './lib.js';

const STORM = Number(process.env.STORM ?? 15);

const run = async () => {
  await ensureServer();

  section('Поставщик A: код выдан, ответ потерян (жёсткий таймаут)');
  await api.admin.post('/api/admin/providers/config', {
    A: { forced: 'timeout', timeoutMs: 3000 },
    B: { forced: 'error' },
  });

  const created = await api.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  const orderId = created.body.order.id;
  await api.post(`/api/orders/${orderId}/pay`, { outcome: 'success' });

  const failed = await waitForStatus(orderId, ['delivery_failed'], { timeoutMs: 30000 });
  check('таймаут даёт восстановимое состояние, а не потерю', failed?.status === 'delivery_failed', failed?.status);

  const { body: mid } = await api.admin.get(`/api/admin/audit/${orderId}`);
  check('поставщик списал ровно один код', mid.provider_issues.length === 1, mid.provider_issues.length);
  check('на резервного поставщика после таймаута не переключились',
    mid.provider_issues.every((item) => item.provider === 'A'), mid.provider_issues.map((i) => i.provider));
  const reservedCode = mid.provider_issues[0]?.code;

  section('Повтор после таймаута возвращает тот же код');
  await resetProviders();
  const delivered = await waitForStatus(orderId, ['delivered'], { timeoutMs: 30000 });
  check('заказ доведён до delivered', delivered?.status === 'delivered', delivered?.status);
  check('выдан тот же код, что был зарезервирован', delivered?.delivery?.code === reservedCode, {
    reserved: reservedCode, delivered: delivered?.delivery?.code,
  });

  const { body: after } = await api.admin.get(`/api/admin/audit/${orderId}`);
  check('израсходован ровно один ключ', after.keys_consumed === 1, after.keys_consumed);
  check('запись о выдаче одна', after.deliveries_count === 1, after.deliveries_count);

  section(`Шторм: ${STORM} заказов при нестабильных поставщиках`);
  await api.admin.post('/api/admin/providers/config', {
    A: { forced: null, failRate: 0.35, timeoutRate: 0.2, timeoutMs: 2000 },
    B: { forced: null, failRate: 0.2, timeoutRate: 0.1, timeoutMs: 2000 },
  });

  const orders = await Promise.all(
    Array.from({ length: STORM }, (unused, index) =>
      api.post('/api/orders', { sku: 'KEY-CS2-PRIME' }, {
        headers: { 'idempotency-key': `storm-${Date.now()}-${index}` },
      }).then((response) => response.body.order.id),
    ),
  );
  await Promise.all(orders.map((id) => api.post(`/api/orders/${id}/pay`, { outcome: 'success' })));
  await Promise.all(orders.map((id) => waitForStatus(id, ['delivered'], { timeoutMs: 45000 })));

  await resetProviders();
  const audits = await Promise.all(orders.map((id) => api.admin.get(`/api/admin/audit/${id}`).then((r) => r.body)));
  const overspent = audits.filter((item) => item.keys_consumed > 1);
  const delivering = audits.filter((item) => item.order.status === 'delivered');

  check('ни один заказ не израсходовал больше одного ключа', overspent.length === 0,
    overspent.map((item) => ({ id: item.order.id, keys: item.keys_consumed })));
  check('у выданных заказов ровно один ключ',
    delivering.every((item) => item.keys_consumed === 1), {
      delivered: delivering.length, total: audits.length,
    });

  const { body: global } = await api.admin.get('/api/admin/audit');
  check('глобальные инварианты целы', global.ok === true, global.totals);

  finish();
};

run();
