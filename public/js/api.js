const request = async (method, path, { body, headers } = {}) => {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? 'Запрос не выполнен');
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload;
};

export const api = {
  catalog: () => request('GET', '/api/catalog'),
  previewPromo: (code, sku) => request('POST', '/api/promo/preview', { body: { code, sku } }),
  createOrder: (payload, idempotencyKey) =>
    request('POST', '/api/orders', { body: payload, headers: { 'idempotency-key': idempotencyKey } }),
  getOrder: (id) => request('GET', `/api/orders/${encodeURIComponent(id)}`),
  pay: (id, outcome) => request('POST', `/api/orders/${encodeURIComponent(id)}/pay`, { body: { outcome } }),
  admin: {
    orders: (token, status = 'stuck') =>
      request('GET', `/api/admin/orders?status=${encodeURIComponent(status)}`, { headers: { 'x-admin-token': token } }),
    stock: (token) => request('GET', '/api/admin/stock', { headers: { 'x-admin-token': token } }),
    audit: (token) => request('GET', '/api/admin/audit', { headers: { 'x-admin-token': token } }),
    redeliver: (token, id) =>
      request('POST', `/api/admin/orders/${encodeURIComponent(id)}/redeliver`, { headers: { 'x-admin-token': token } }),
    refill: (token, body) => request('POST', '/api/admin/keys/refill', { body, headers: { 'x-admin-token': token } }),
    drain: (token, body) => request('POST', '/api/admin/keys/drain', { body, headers: { 'x-admin-token': token } }),
  },
};

export const formatMoney = (minor, currency = 'RUB') => {
  const symbols = { RUB: '₽', USD: '$', KZT: '₸' };
  const value = (minor / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  return `${value} ${symbols[currency] ?? currency}`;
};

export const STATUS_LABEL = {
  created: 'Создан, ожидает оплаты',
  paid: 'Оплачен, запускается выдача',
  delivering: 'Идёт получение кода у поставщика',
  delivered: 'Код выдан',
  payment_failed: 'Оплата не прошла',
  out_of_stock: 'Оплачен, кода нет в наличии',
  delivery_failed: 'Поставщики не смогли выдать код',
};

export const STATUS_TONE = {
  delivered: 'ok',
  payment_failed: 'err',
  out_of_stock: 'warn',
  delivery_failed: 'warn',
};
