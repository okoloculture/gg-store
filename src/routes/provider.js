import { badRequest } from '../lib/errors.js';
import { sendJson } from '../lib/http.js';
import { handleIssueRequest } from '../services/providerStub.js';

const PROVIDERS = { a: 'A', b: 'B' };

/**
 * Заглушки поставщиков выдачи по контракту POST /issue.
 * Вынесены за HTTP намеренно: магазин ходит к ним так же, как ходил бы
 * к внешнему поставщику, включая таймауты и потерю ответа.
 */
export const registerProviderRoutes = (router) => {
  router.post('/provider/:provider/issue', async (req, res, { params, body }) => {
    const provider = PROVIDERS[String(params.provider).toLowerCase()];
    if (!provider) throw badRequest('unknown_provider', 'Неизвестный поставщик');

    const requestId = String(body?.request_id ?? '').trim();
    const sku = String(body?.sku ?? '').trim();
    const orderId = String(body?.order_id ?? '').trim();
    if (!requestId || !sku || !orderId) {
      throw badRequest('invalid_request', 'Нужны request_id, sku и order_id');
    }

    const result = await handleIssueRequest({ provider, sku, orderId, requestId });
    sendJson(res, result.httpStatus, result.body);
  });
};
