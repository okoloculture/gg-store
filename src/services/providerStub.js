import { sql } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Заглушка поставщика выдачи. Живёт за HTTP (см. routes/provider.js), имеет
 * собственный пул кодов и собственный журнал request_id -> code.
 *
 * Поведение сбоев настраивается в рантайме (админка / тестовые скрипты), чтобы
 * сценарии "5xx", "таймаут" и "пустой пул" воспроизводились детерминированно.
 */
const runtime = {
  A: { ...config.providers.A, timeoutMs: config.providerHangMs, forced: null },
  B: { ...config.providers.B, timeoutMs: config.providerHangMs, forced: null },
};

export const getProviderConfig = () => structuredClone(runtime);

export const setProviderConfig = (patch) => {
  for (const [name, values] of Object.entries(patch ?? {})) {
    const key = String(name).toUpperCase();
    if (!runtime[key]) continue;
    if (values.failRate !== undefined) runtime[key].failRate = Math.min(1, Math.max(0, Number(values.failRate)));
    if (values.timeoutRate !== undefined) runtime[key].timeoutRate = Math.min(1, Math.max(0, Number(values.timeoutRate)));
    if (values.timeoutMs !== undefined) runtime[key].timeoutMs = Math.max(0, Number(values.timeoutMs));
    // forced: 'ok' | 'error' | 'timeout' | null — жёсткий режим для тестов.
    if (values.forced !== undefined) runtime[key].forced = values.forced || null;
  }
  return getProviderConfig();
};

const decideBehaviour = (provider) => {
  const cfg = runtime[provider];
  if (cfg.forced) return cfg.forced;
  const roll = Math.random();
  if (roll < cfg.timeoutRate) return 'timeout';
  if (roll < cfg.timeoutRate + cfg.failRate) return 'error';
  return 'ok';
};

/**
 * Атомарно достаёт код из пула и привязывает его к request_id.
 *
 * Повтор с тем же request_id возвращает тот же код из журнала — второй ключ
 * не расходуется. UNIQUE(provider_keys.request_id) гарантирует это даже при
 * параллельных вызовах: занять свободную строку сможет ровно один.
 */
export const issueCode = ({ provider, sku, orderId, requestId }) =>
  sql.transaction(async () => {
    const known = await sql.get('SELECT * FROM provider_issues WHERE request_id = ?', requestId);
    if (known) return { status: 'ok', code: known.code, replayed: true };

    // SKIP LOCKED в Postgres пропускает строки, которые прямо сейчас забирает
    // другой запрос: без него параллельные попытки упирались бы в одну и ту же
    // строку и получали ложный out_of_stock. В SQLite транзакции сериализованы
    // целиком, и такой строки в подзапросе просто не бывает.
    const claimed = await sql.run(
      `UPDATE provider_keys SET request_id = ?, issued_at = ?
       WHERE id = (
         SELECT id FROM provider_keys
         WHERE provider = ? AND sku = ? AND request_id IS NULL
         ORDER BY id LIMIT 1${sql.skipLocked}
       ) AND request_id IS NULL`,
      requestId, new Date().toISOString(), provider, sku,
    );

    if (claimed !== 1) return { status: 'error', reason: 'out_of_stock' };

    const key = await sql.get('SELECT code FROM provider_keys WHERE request_id = ?', requestId);
    await sql.run(
      'INSERT INTO provider_issues (request_id, provider, order_id, sku, code, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      requestId, provider, orderId, sku, key.code, new Date().toISOString(),
    );

    return { status: 'ok', code: key.code, replayed: false };
  });

/**
 * Ловушка таймаута: код УЖЕ выдан и списан из пула, а ответ не доходит.
 * Клиент обязан повторить с тем же request_id и получить тот же код.
 */
export const handleIssueRequest = async ({ provider, sku, orderId, requestId }) => {
  const behaviour = decideBehaviour(provider);

  if (behaviour === 'error') {
    return { httpStatus: 503, body: { status: 'error', reason: 'provider_unavailable' } };
  }

  const result = await issueCode({ provider, sku, orderId, requestId });

  if (behaviour === 'timeout') {
    logger.warn('поставщик "завис" после выдачи кода', { provider, requestId, issued: result.status === 'ok' });
    await new Promise((resolve) => setTimeout(resolve, runtime[provider].timeoutMs));
  }

  if (result.status === 'error') {
    return { httpStatus: 409, body: { status: 'error', reason: result.reason } };
  }
  return { httpStatus: 200, body: { status: 'ok', request_id: requestId, code: result.code } };
};

export const stockByProvider = () =>
  sql.all(
    `SELECT provider, sku,
            CAST(SUM(CASE WHEN request_id IS NULL THEN 1 ELSE 0 END) AS INTEGER) AS available,
            CAST(COUNT(*) AS INTEGER) AS total
     FROM provider_keys GROUP BY provider, sku ORDER BY sku, provider`,
  );

export const refillPool = ({ provider, sku, codes }) =>
  sql.transaction(async () => {
    let added = 0;
    for (const code of codes) {
      added += await sql.run(
        'INSERT OR IGNORE INTO provider_keys (provider, sku, code) VALUES (?, ?, ?)',
        provider, sku, String(code).trim(),
      );
    }
    return added;
  });

export const drainPool = ({ sku, provider }) =>
  sql.transaction(() =>
    sql.run(
      `UPDATE provider_keys SET request_id = 'drained_' || id, issued_at = ?
       WHERE sku = ? AND request_id IS NULL${provider ? ' AND provider = ?' : ''}`,
      new Date().toISOString(), sku, ...(provider ? [provider] : []),
    ));
