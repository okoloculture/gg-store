import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export const PROVIDER_ORDER = ['A', 'B'];

// На Vercel заглушка живёт в той же функции, но вызывается по HTTP, как
// вызывался бы внешний поставщик: адрес берётся из PUBLIC_BASE_URL/VERCEL_URL.
const baseUrl = () => config.publicBaseUrl ?? `http://${config.host}:${config.port}`;

/**
 * Один вызов POST /provider/:id/issue с жёстким таймаутом.
 * Возвращает { outcome: 'ok' | 'out_of_stock' | 'error' | 'timeout' }.
 */
const callOnce = async ({ provider, sku, orderId, requestId }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.providerTimeoutMs);
  try {
    const response = await fetch(`${baseUrl()}/provider/${provider.toLowerCase()}/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, sku, order_id: orderId }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.status === 'ok' && body.code) {
      return { outcome: 'ok', code: body.code };
    }
    if (body.reason === 'out_of_stock') return { outcome: 'out_of_stock', reason: 'out_of_stock' };
    return { outcome: 'error', reason: body.reason ?? `http_${response.status}` };
  } catch (error) {
    if (error?.name === 'AbortError') return { outcome: 'timeout', reason: 'timeout' };
    return { outcome: 'error', reason: error?.message ?? 'network_error' };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Запрос кода у поставщика с повторами.
 *
 * Ключевое: повтор идёт с ТЕМ ЖЕ request_id и к ТОМУ ЖЕ поставщику.
 * Таймаут не равен отказу — поставщик мог успеть списать код, поэтому
 * переключаться на резервного поставщика после таймаута нельзя: это
 * израсходовало бы второй ключ. Смена поставщика допустима только после
 * явного ответа (out_of_stock / ошибка).
 */
export const requestCode = async ({ provider, sku, orderId, requestId }) => {
  let last = { outcome: 'error', reason: 'not_attempted' };
  for (let attempt = 0; attempt <= config.providerRetries; attempt += 1) {
    last = await callOnce({ provider, sku, orderId, requestId });
    logger.debug('ответ поставщика', { provider, requestId, attempt, outcome: last.outcome });
    if (last.outcome === 'ok' || last.outcome === 'out_of_stock') return last;
    if (last.outcome === 'error' && attempt >= config.providerRetries) return last;
  }
  return last;
};
