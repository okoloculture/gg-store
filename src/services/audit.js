import { db } from '../db/index.js';

/**
 * Инварианты, которые проверяют состязательные сценарии.
 * Все три обязаны быть пустыми/нулевыми при любой нагрузке.
 */
export const audit = () => {
  const duplicateCodes = db
    .prepare('SELECT code, COUNT(*) AS n FROM deliveries GROUP BY code HAVING n > 1')
    .all();

  // Заказ, под который поставщики списали больше одного кода.
  const overspentOrders = db
    .prepare('SELECT order_id, COUNT(*) AS n FROM provider_issues GROUP BY order_id HAVING n > 1')
    .all();

  // Код списан из пула, но не привязан ни к одной выдаче и ни к одному запросу.
  const orphanKeys = db
    .prepare(
      `SELECT code FROM provider_keys
        WHERE request_id IS NOT NULL
          AND request_id NOT LIKE 'drained_%'
          AND request_id NOT IN (SELECT request_id FROM provider_issues)`,
    )
    .all();

  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM orders) AS orders,
         (SELECT COUNT(*) FROM deliveries) AS deliveries,
         (SELECT COUNT(*) FROM provider_issues) AS provider_issues,
         (SELECT COUNT(*) FROM payment_events) AS payment_events,
         (SELECT COUNT(*) FROM provider_keys WHERE request_id IS NULL) AS keys_available`,
    )
    .get();

  return {
    ok: duplicateCodes.length === 0 && overspentOrders.length === 0 && orphanKeys.length === 0,
    duplicateCodes,
    overspentOrders,
    orphanKeys,
    totals,
  };
};

export const orderAudit = (orderId) => ({
  order: db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) ?? null,
  delivery: db.prepare('SELECT * FROM deliveries WHERE order_id = ?').get(orderId) ?? null,
  deliveries_count: db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE order_id = ?').get(orderId).n,
  provider_issues: db.prepare('SELECT * FROM provider_issues WHERE order_id = ?').all(orderId),
  payment_events: db.prepare('SELECT COUNT(*) AS n FROM payment_events WHERE order_id = ?').get(orderId).n,
  keys_consumed: db
    .prepare("SELECT COUNT(*) AS n FROM provider_keys WHERE request_id LIKE ?")
    .get(`req_${orderId}_%`).n,
});
