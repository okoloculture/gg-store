import { api, formatMoney, STATUS_LABEL, STATUS_TONE } from './api.js';

const root = document.getElementById('order-root');
const orderId = new URLSearchParams(location.search).get('id');

const PENDING = ['created', 'paid', 'delivering'];

const render = (order) => {
  const tone = STATUS_TONE[order.status] ?? '';
  root.innerHTML = `
    <p><span class="pill pill--${tone}">${STATUS_LABEL[order.status] ?? order.status}</span></p>
    <table>
      <tbody>
        <tr><th>Заказ</th><td class="mono">${order.id}</td></tr>
        <tr><th>Товар</th><td>${order.sku}</td></tr>
        <tr><th>Базовая цена</th><td>${formatMoney(order.base_amount_minor, order.currency)}</td></tr>
        <tr><th>Скидка</th><td>${formatMoney(order.discount_minor, order.currency)}${order.promo_code ? ` (${order.promo_code})` : ''}</td></tr>
        <tr><th>К оплате</th><td><b>${formatMoney(order.amount_minor, order.currency)}</b></td></tr>
        <tr><th>Попыток выдачи</th><td>${order.delivery_attempts}</td></tr>
        ${order.last_error ? `<tr><th>Последняя ошибка</th><td class="mono">${order.last_error}</td></tr>` : ''}
        <tr><th>Создан</th><td>${new Date(order.created_at).toLocaleString('ru-RU')}</td></tr>
      </tbody>
    </table>
    ${order.delivery
      ? `<h2>Ваш код</h2><div class="code">${order.delivery.code}</div>
         <p class="note">Поставщик ${order.delivery.provider}, выдан ${new Date(order.delivery.issued_at).toLocaleString('ru-RU')}</p>`
      : ''}
    ${order.status === 'created'
      ? `<h2>Эмуляция оплаты</h2>
         <div class="toolbar">
           <button class="btn btn--primary" data-pay="success">Оплатить (успех)</button>
           <button class="btn btn--ghost" data-pay="fail">Оплатить (неуспех)</button>
         </div>
         <p class="note">Кнопка отправляет вебхук по контракту на /api/webhooks/payment.</p>`
      : ''}
    ${['out_of_stock', 'delivery_failed'].includes(order.status)
      ? '<p class="note">Заказ в восстановимом состоянии. Повторную выдачу можно запустить из админки после пополнения пула.</p>'
      : ''}`;

  root.querySelectorAll('[data-pay]').forEach((button) => {
    button.addEventListener('click', async () => {
      root.querySelectorAll('[data-pay]').forEach((other) => { other.disabled = true; });
      const result = await api.pay(order.id, button.dataset.pay);
      render(result.order);
      poll();
    });
  });
};

let timer = null;
const poll = () => {
  clearInterval(timer);
  timer = setInterval(async () => {
    const { order } = await api.getOrder(orderId);
    render(order);
    if (!PENDING.includes(order.status)) clearInterval(timer);
  }, 800);
};

const boot = async () => {
  if (!orderId) {
    root.innerHTML = '<p class="error">Не передан id заказа: order.html?id=ord_...</p>';
    return;
  }
  try {
    const { order } = await api.getOrder(orderId);
    render(order);
    if (PENDING.includes(order.status)) poll();
  } catch (error) {
    root.innerHTML = `<p class="error">${error.message}</p>`;
  }
};

boot();
