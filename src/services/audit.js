import { sql } from '../db/index.js';

/**
 * Инварианты, которые проверяют состязательные сценарии.
 * Все три обязаны быть пустыми/нулевыми при любой нагрузке.
 */
export const audit = async () => {
  const duplicateCodes = await sql.all(
    'SELECT code, CAST(COUNT(*) AS INTEGER) AS n FROM deliveries GROUP BY code HAVING COUNT(*) > 1',
  );

  // Заказ, под который поставщики списали больше одного кода.
  const overspentOrders = await sql.all(
    'SELECT order_id, CAST(COUNT(*) AS INTEGER) AS n FROM provider_issues GROUP BY order_id HAVING COUNT(*) > 1',
  );

  // Код списан из пула, но не привязан ни к одной выдаче и ни к одному запросу.
  const orphanKeys = await sql.all(
    `SELECT code FROM provider_keys
      WHERE request_id IS NOT NULL
        AND request_id NOT LIKE 'drained_%'
        AND request_id NOT IN (SELECT request_id FROM provider_issues)`,
  );

  const totals = await sql.get(
    `SELECT
       CAST((SELECT COUNT(*) FROM orders) AS INTEGER) AS orders,
       CAST((SELECT COUNT(*) FROM deliveries) AS INTEGER) AS deliveries,
       CAST((SELECT COUNT(*) FROM provider_issues) AS INTEGER) AS provider_issues,
       CAST((SELECT COUNT(*) FROM payment_events) AS INTEGER) AS payment_events,
       CAST((SELECT COUNT(*) FROM provider_keys WHERE request_id IS NULL) AS INTEGER) AS keys_available`,
  );

  return {
    ok: duplicateCodes.length === 0 && overspentOrders.length === 0 && orphanKeys.length === 0,
    duplicateCodes,
    overspentOrders,
    orphanKeys,
    totals,
  };
};

export const orderAudit = async (orderId) => {
  const [order, delivery, deliveries, issues, events, keys] = await Promise.all([
    sql.get('SELECT * FROM orders WHERE id = ?', orderId),
    sql.get('SELECT * FROM deliveries WHERE order_id = ?', orderId),
    sql.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM deliveries WHERE order_id = ?', orderId),
    sql.all('SELECT * FROM provider_issues WHERE order_id = ?', orderId),
    sql.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM payment_events WHERE order_id = ?', orderId),
    sql.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM provider_keys WHERE request_id LIKE ?', `req_${orderId}_%`),
  ]);

  return {
    order,
    delivery,
    deliveries_count: deliveries.n,
    provider_issues: issues,
    payment_events: events.n,
    keys_consumed: keys.n,
  };
};
