import { api, formatMoney, STATUS_LABEL, STATUS_TONE } from './api.js';

const modal = document.getElementById('modal');
const modalBody = document.getElementById('modal-body');
const modalTitle = document.getElementById('modal-title');

let pollTimer = null;

const stopPolling = () => {
  clearInterval(pollTimer);
  pollTimer = null;
};

export const closeModal = () => {
  stopPolling();
  modal.hidden = true;
};

modal?.addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) closeModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modal && !modal.hidden) closeModal();
});

const renderOrder = (order, note) => {
  const tone = STATUS_TONE[order.status] ?? '';
  const paid = order.status !== 'created';
  modalBody.innerHTML = `
    <dl class="kv">
      <dt>Заказ</dt><dd>${order.id}</dd>
      <dt>Товар</dt><dd>${order.sku}</dd>
      <dt>Сумма</dt><dd>${formatMoney(order.amount_minor, order.currency)}${
        order.discount_minor ? ` <s>${formatMoney(order.base_amount_minor, order.currency)}</s>` : ''
      }</dd>
      ${order.promo_code ? `<dt>Промокод</dt><dd>${order.promo_code}</dd>` : ''}
      <dt>Статус</dt><dd>${STATUS_LABEL[order.status] ?? order.status}</dd>
    </dl>
    <div class="modal__actions">
      ${paid ? '' : '<button class="btn btn--primary" data-pay="success">Оплатить (успех)</button>'}
      ${paid ? '' : '<button class="btn btn--ghost" data-pay="fail">Оплатить (неуспех)</button>'}
      <a class="btn btn--ghost" href="order.html?id=${encodeURIComponent(order.id)}">Страница статуса</a>
    </div>
    <div class="status status--${tone}">
      ${note ?? ''}
      ${order.delivery ? `<span class="code">${order.delivery.code}</span>` : ''}
    </div>`;

  modalBody.querySelectorAll('[data-pay]').forEach((button) => {
    button.addEventListener('click', async () => {
      modalBody.querySelectorAll('[data-pay]').forEach((other) => { other.disabled = true; });
      const outcome = button.dataset.pay;
      const result = await api.pay(order.id, outcome);
      renderOrder(result.order, outcome === 'fail' ? 'Платёж отклонён' : 'Платёж принят, идёт выдача...');
      if (outcome !== 'fail') startPolling(order.id);
    });
  });
};

const startPolling = (orderId) => {
  stopPolling();
  let attempts = 0;
  pollTimer = setInterval(async () => {
    attempts += 1;
    const { order } = await api.getOrder(orderId);
    if (['delivered', 'payment_failed', 'out_of_stock', 'delivery_failed'].includes(order.status)) {
      stopPolling();
      const notes = {
        delivered: 'Код выдан:',
        out_of_stock: 'Оплата прошла, но кода нет в наличии. Заказ восстановим: админ выдаст код после пополнения.',
        delivery_failed: 'Поставщики временно недоступны. Заказ восстановим, идут автоповторы.',
        payment_failed: 'Платёж не прошёл.',
      };
      renderOrder(order, notes[order.status]);
      return;
    }
    if (attempts > 40) stopPolling();
  }, 600);
};

export const openPurchase = (order, note) => {
  modalTitle.textContent = 'Оформление заказа';
  modal.hidden = false;
  renderOrder(order, note);
};

/**
 * Двойной клик по "Купить" не должен создавать второй заказ.
 * Кнопка блокируется на время запроса, а ключ идемпотентности переживает
 * повторные клики: сервер вернёт по нему тот же заказ.
 */
export const attachBuy = (button, buildPayload) => {
  button.addEventListener('click', async () => {
    if (button.dataset.busy === '1') return;
    button.dataset.busy = '1';
    button.disabled = true;
    if (!button.dataset.idemKey) {
      button.dataset.idemKey = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    try {
      const { order } = await api.createOrder(buildPayload(), button.dataset.idemKey);
      openPurchase(order);
    } catch (error) {
      openPurchase(
        { id: '—', sku: '—', status: 'created', amount_minor: 0, base_amount_minor: 0, discount_minor: 0, currency: 'RUB' },
        `Не удалось создать заказ: ${error.message}`,
      );
    } finally {
      button.dataset.busy = '0';
      button.disabled = false;
      delete button.dataset.idemKey;
    }
  });
};
