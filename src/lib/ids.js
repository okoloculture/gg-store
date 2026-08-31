import { randomBytes } from 'node:crypto';

const token = (bytes = 6) => randomBytes(bytes).toString('hex');

export const orderId = () => `ord_${Date.now().toString(36)}${token(3)}`;
export const eventId = () => `evt_${token(6)}`;

/**
 * Ключ идемпотентности запроса к поставщику детерминирован от заказа и
 * поставщика. Любой повтор (после таймаута, рестарта, перехвата аренды)
 * попадёт в тот же request_id, поставщик вернёт тот же код, второй ключ из
 * пула не расходуется.
 */
export const providerRequestId = (order, provider) => `req_${order}_${provider}`;
