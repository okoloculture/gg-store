/** Кнопка "Каталог": открытие, повторный клик, клик вне меню, Esc. */
export const initCatalogMenu = () => {
  const button = document.getElementById('catalog-btn');
  const menu = document.getElementById('catalog-menu');
  if (!button || !menu) return;

  const setOpen = (open) => {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(menu.hidden);
  });

  document.addEventListener('click', (event) => {
    if (menu.hidden) return;
    if (menu.contains(event.target)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      setOpen(false);
      button.focus();
    }
  });

  menu.querySelectorAll('.catalog-menu__cat').forEach((item) => {
    item.addEventListener('click', () => {
      menu.querySelectorAll('.catalog-menu__cat').forEach((other) => other.classList.remove('is-active'));
      item.classList.add('is-active');
    });
  });
};
