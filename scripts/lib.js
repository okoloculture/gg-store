const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3210';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';

export const baseUrl = BASE;

const request = async (method, path, { body, headers } = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
};

export const api = {
  get: (path, options) => request('GET', path, options),
  post: (path, body, options) => request('POST', path, { body, ...(options ?? {}) }),
  admin: {
    get: (path) => request('GET', path, { headers: { 'x-admin-token': ADMIN_TOKEN } }),
    post: (path, body) => request('POST', path, { body, headers: { 'x-admin-token': ADMIN_TOKEN } }),
  },
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const waitFor = async (predicate, { timeoutMs = 20000, intervalMs = 200 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
};

export const waitForStatus = (orderId, statuses, options) =>
  waitFor(async () => {
    const { body } = await api.get(`/api/orders/${orderId}`);
    return statuses.includes(body?.order?.status) ? body.order : null;
  }, options);

export const checks = [];

export const check = (label, condition, actual) => {
  checks.push({ label, ok: Boolean(condition) });
  const mark = condition ? 'PASS' : 'FAIL';
  const detail = actual === undefined ? '' : ` -> ${JSON.stringify(actual)}`;
  process.stdout.write(`  [${mark}] ${label}${detail}\n`);
};

export const section = (title) => process.stdout.write(`\n=== ${title} ===\n`);

export const finish = () => {
  const failed = checks.filter((item) => !item.ok);
  process.stdout.write(`\nИтого: ${checks.length - failed.length}/${checks.length} проверок пройдено\n`);
  if (failed.length) {
    process.stdout.write(`Провалено: ${failed.map((item) => item.label).join('; ')}\n`);
    process.exitCode = 1;
  }
  return failed.length === 0;
};

export const ensureServer = async () => {
  const result = await api.get('/api/health').catch(() => ({ status: 0 }));
  if (result.status !== 200) {
    process.stdout.write(`Сервер недоступен на ${BASE}. Запустите: npm start\n`);
    process.exit(1);
  }
};

export const createOrder = async (sku, extra = {}) => {
  const { body } = await api.post('/api/orders', { sku, ...extra }, {
    headers: { 'idempotency-key': `script-${Math.random().toString(36).slice(2)}` },
  });
  return body.order;
};

export const resetProviders = () =>
  api.admin.post('/api/admin/providers/config', { A: { forced: 'ok' }, B: { forced: 'ok' } });
