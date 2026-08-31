import { api } from './api.js';
import { initBanner } from './banner.js';
import { initCatalogMenu } from './catalog-menu.js';
import { attachBuy } from './purchase.js';

const SERVICES = [
  { name: 'Steam', image: 'assets/steam.png', border: '#1482b3' },
  { name: 'Telegram', image: 'assets/telegram.png', border: '#45baee' },
  { name: 'Roblox', image: 'assets/roblox.png', border: '#b8c5ff' },
  { name: 'Brawl Stars', image: 'assets/brawlstars.png', border: '#e86eff' },
  { name: 'PUBG Mob...', image: 'assets/pubgm.png', border: '#111111' },
  { name: 'App Store', image: 'assets/appstore.png', border: '#4acdff' },
  { name: 'ChatGPT', image: 'assets/chatgpt.png', border: '#38d4ad' },
  { name: 'PlayStation', image: 'assets/playstation.png', border: '#117fda' },
  { name: 'TikTok', image: 'assets/tiktok.png', border: '#454545' },
  { name: 'Mobile Leg..', image: 'assets/mlbb.png', border: '#dfe5ef' },
];

const renderServices = () => {
  const root = document.getElementById('services');
  root.innerHTML = `${SERVICES.map((service) => `
    <button class="service" type="button" title="${service.name}">
      <span class="tile" style="--tile-border:${service.border}"><img src="${service.image}" alt="${service.name}"></span>
      <span class="service__label">${service.name}</span>
    </button>`).join('')}
    <button class="service service--more" type="button">
      <span class="tile">···</span>
      <span class="service__label">еще 841</span>
    </button>`;
};

const priceWithFakeDiscount = (price) => Math.round((price * 1.55) / 10) * 10;

const renderProducts = (products) => {
  const root = document.getElementById('products');
  // В макете один ряд карточек: показываем первые пять товаров каталога.
  const visible = products.slice(3, 8);
  root.innerHTML = visible.map((product) => `
    <article class="product">
      <div class="product__img"><img src="${product.image}" alt=""></div>
      <div class="product__body">
        <h3 class="product__title">${product.name}</h3>
        <div class="product__price">
          <strong>${product.price.toLocaleString('ru-RU')} ₽</strong>
          <s>${priceWithFakeDiscount(product.price).toLocaleString('ru-RU')} ₽</s>
        </div>
        <button class="product__buy" type="button" data-sku="${product.sku}">Купить</button>
      </div>
    </article>`).join('');

  root.querySelectorAll('.product__buy').forEach((button) => {
    attachBuy(button, () => ({ sku: button.dataset.sku }));
  });
};

/** Переключатель валют: только активное состояние, пересчёт не требуется. */
const initCurrency = () => {
  const group = document.getElementById('currency');
  group.addEventListener('click', (event) => {
    const button = event.target.closest('.currency__btn');
    if (!button) return;
    group.querySelectorAll('.currency__btn').forEach((item) => item.classList.remove('is-active'));
    button.classList.add('is-active');
  });
};

const initTopup = () => {
  const payButton = document.getElementById('topup-pay');
  const hint = document.getElementById('promo-hint');
  let promoCode = null;

  document.getElementById('promo-btn').addEventListener('click', async () => {
    const input = window.prompt('Промокод (например, WELCOME10)');
    if (input === null) return;
    const code = input.trim();
    hint.hidden = false;
    if (!code) {
      promoCode = null;
      hint.removeAttribute('data-error');
      hint.textContent = 'Промокод убран';
      return;
    }
    try {
      // Скидку считает сервер; предпросмотр только показывает результат расчёта.
      const preview = await api.previewPromo(code, payButton.dataset.sku);
      promoCode = preview.code;
      hint.removeAttribute('data-error');
      hint.textContent = `${preview.code}: скидка ${(preview.discount_minor / 100).toLocaleString('ru-RU')} ₽, осталось ${preview.uses_left}`;
    } catch (error) {
      promoCode = null;
      hint.dataset.error = '1';
      hint.textContent = error.message;
    }
  });

  attachBuy(payButton, () => ({
    sku: payButton.dataset.sku,
    promo_code: promoCode ?? undefined,
    steam_login: document.getElementById('steam-login').value || undefined,
  }));
};

const boot = async () => {
  initCatalogMenu();
  initBanner();
  renderServices();
  initCurrency();
  initTopup();

  const { products } = await api.catalog();
  renderProducts(products);
};

boot();
