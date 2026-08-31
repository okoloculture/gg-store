const SLIDES = [
  { title: 'Пополнение Steam без комиссии', text: 'Зачисление за 2 минуты, курс фиксируется в момент оплаты', cta: 'Пополнить', art: 'assets/steam.png', from: '#0b1622', to: '#1b4b6d' },
  { title: 'Ключи Steam дешевле на 40%', text: 'Мгновенная выдача из пула сразу после оплаты', cta: 'Смотреть ключи', art: 'assets/game-wildcat.png', from: '#2b0f2c', to: '#7a1f4b' },
  { title: 'Brawl Stars: гемы и Brawl Pass', text: 'Прямое пополнение по игровому ID, без входа в аккаунт', cta: 'Купить гемы', art: 'assets/brawlstars.png', from: '#231043', to: '#6a2fb5' },
  { title: 'PUBG Mobile UC', text: 'Официальные пакеты UC с бонусами за объём', cta: 'Выбрать пакет', art: 'assets/pubgm.png', from: '#141b0d', to: '#5c6b1f' },
  { title: 'Подписки: Discord, YouTube, Spotify', text: 'Продление на ваш аккаунт без смены пароля', cta: 'Оформить', art: 'assets/chatgpt.png', from: '#0d2020', to: '#1f6b5c' },
  { title: 'Mobile Legends: алмазы', text: 'Пополнение по ID за минуту, поддержка 24/7', cta: 'Пополнить', art: 'assets/mlbb.png', from: '#101a33', to: '#2f4fa8' },
];

const AUTOPLAY_MS = 5000;

export const initBanner = () => {
  const root = document.getElementById('banner');
  const track = document.getElementById('banner-track');
  const dots = document.getElementById('banner-dots');
  if (!root || !track || !dots) return;

  track.innerHTML = SLIDES.map((slide) => `
    <article class="banner__slide" style="background: linear-gradient(120deg, ${slide.from}, ${slide.to})">
      <div class="banner__text">
        <h2>${slide.title}</h2>
        <p>${slide.text}</p>
        <button class="banner__cta" type="button">${slide.cta}</button>
      </div>
      <img class="banner__art" src="${slide.art}" alt="">
    </article>`).join('');

  dots.innerHTML = SLIDES.map((slide, index) =>
    `<button type="button" data-index="${index}" aria-label="Слайд ${index + 1}"></button>`).join('');

  let current = 0;
  let timer = null;

  const render = () => {
    track.style.transform = `translateX(-${current * 100}%)`;
    [...dots.children].forEach((dot, index) => dot.classList.toggle('is-active', index === current));
  };

  const go = (index) => {
    current = (index + SLIDES.length) % SLIDES.length;
    render();
  };

  const restart = () => {
    clearInterval(timer);
    timer = setInterval(() => go(current + 1), AUTOPLAY_MS);
  };

  document.getElementById('banner-prev').addEventListener('click', () => { go(current - 1); restart(); });
  document.getElementById('banner-next').addEventListener('click', () => { go(current + 1); restart(); });
  dots.addEventListener('click', (event) => {
    const index = event.target.closest('button')?.dataset.index;
    if (index === undefined) return;
    go(Number(index));
    restart();
  });

  // Автопрокрутка не мешает чтению: пауза на наведение и при скрытой вкладке.
  root.addEventListener('mouseenter', () => clearInterval(timer));
  root.addEventListener('mouseleave', restart);
  document.addEventListener('visibilitychange', () => (document.hidden ? clearInterval(timer) : restart()));

  render();
  restart();
};
