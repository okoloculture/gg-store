import { api, formatMoney, STATUS_LABEL, STATUS_TONE } from './api.js';

const el = (id) => document.getElementById(id);
const token = () => el('token').value.trim();
const RECOVERABLE = ['paid', 'out_of_stock', 'delivery_failed', 'delivering'];

const showError = (message) => { el('error').textContent = message ?? ''; };

const renderOrders = (orders) => {
  if (!orders.length) {
    el('orders').innerHTML = '<p class="note">Заказов в этом статусе нет.</p>';
    return;
  }
  el('orders').innerHTML = `
    <table>
      <thead><tr><th>Заказ</th><th>Товар</th><th>Сумма</th><th>Статус</th><th>Попыток</th><th>Код</th><th></th></tr></thead>
      <tbody>${orders.map((order) => `
        <tr>
          <td class="mono"><a href="order.html?id=${encodeURIComponent(order.id)}">${order.id}</a></td>
          <td>${order.sku}</td>
          <td>${formatMoney(order.amount_minor, order.currency)}</td>
          <td><span class="pill pill--${STATUS_TONE[order.status] ?? ''}">${STATUS_LABEL[order.status] ?? order.status}</span>
            ${order.last_error ? `<div class="note">${order.last_error}</div>` : ''}</td>
          <td>${order.delivery_attempts}</td>
          <td class="mono">${order.delivery?.code ?? '—'}</td>
          <td>${RECOVERABLE.includes(order.status)
            ? `<button class="btn btn--primary" data-redeliver="${order.id}">Выдать повторно</button>`
            : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p class="note">Повторная выдача идемпотентна: на уже выданном заказе вернётся тот же код, новый ключ не расходуется.</p>`;

  el('orders').querySelectorAll('[data-redeliver]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api.admin.redeliver(token(), button.dataset.redeliver);
        await reload();
      } catch (error) {
        showError(error.message);
        button.disabled = false;
      }
    });
  });
};

const renderStock = (stock) => {
  el('stock').innerHTML = `
    <table>
      <thead><tr><th>SKU</th><th>Поставщик</th><th>Свободно</th><th>Всего</th></tr></thead>
      <tbody>${stock.map((row) => `
        <tr><td>${row.sku}</td><td>${row.provider}</td><td><b>${row.available}</b></td><td>${row.total}</td></tr>`).join('')}
      </tbody>
    </table>`;

  const select = el('refill-sku');
  const previous = select.value;
  const skus = [...new Set(stock.map((row) => row.sku))];
  select.innerHTML = skus.map((sku) => `<option value="${sku}">${sku}</option>`).join('');
  if (previous) select.value = previous;
};

const renderPromos = (promocodes) => {
  el('promos').innerHTML = `
    <table>
      <thead><tr><th>Код</th><th>Скидка</th><th>Использовано</th></tr></thead>
      <tbody>${promocodes.map((promo) => `
        <tr>
          <td class="mono">${promo.code}</td>
          <td>${promo.type === 'percent' ? `${promo.value}%` : formatMoney(promo.value)}</td>
          <td>${promo.used_count} / ${promo.max_uses}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
};

const renderAudit = (audit) => {
  el('audit').innerHTML = `
    <p><span class="pill pill--${audit.ok ? 'ok' : 'err'}">${audit.ok ? 'нарушений нет' : 'НАРУШЕНИЕ'}</span></p>
    <table>
      <tbody>
        <tr><th>Заказов</th><td>${audit.totals.orders}</td></tr>
        <tr><th>Выдач</th><td>${audit.totals.deliveries}</td></tr>
        <tr><th>Кодов списано поставщиками</th><td>${audit.totals.provider_issues}</td></tr>
        <tr><th>Событий оплаты</th><td>${audit.totals.payment_events}</td></tr>
        <tr><th>Свободных ключей</th><td>${audit.totals.keys_available}</td></tr>
        <tr><th>Один код в двух заказах</th><td>${audit.duplicateCodes.length}</td></tr>
        <tr><th>Заказов с лишним ключом</th><td>${audit.overspentOrders.length}</td></tr>
      </tbody>
    </table>`;
};

const reload = async () => {
  showError('');
  try {
    const [orders, stock, audit] = await Promise.all([
      api.admin.orders(token(), el('filter').value),
      api.admin.stock(token()),
      api.admin.audit(token()),
    ]);
    renderOrders(orders.orders);
    renderStock(stock.stock);
    renderPromos(stock.promocodes);
    renderAudit(audit);
  } catch (error) {
    showError(error.message);
  }
};

el('reload').addEventListener('click', reload);
el('filter').addEventListener('change', reload);

el('refill').addEventListener('click', async () => {
  try {
    await api.admin.refill(token(), {
      provider: el('refill-provider').value,
      sku: el('refill-sku').value,
      count: Number(el('refill-count').value) || 1,
    });
    await reload();
  } catch (error) {
    showError(error.message);
  }
});

el('drain').addEventListener('click', async () => {
  try {
    await api.admin.drain(token(), { sku: el('refill-sku').value, provider: el('refill-provider').value });
    await reload();
  } catch (error) {
    showError(error.message);
  }
});

reload();
