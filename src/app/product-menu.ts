import type { Product } from './types.js';

export function createProductMenu({
  trigger,
  menu,
  label,
  items,
  onSelect,
}: {
  readonly trigger: HTMLButtonElement;
  readonly menu: HTMLElement;
  readonly label: HTMLElement;
  readonly items: readonly (readonly [HTMLButtonElement, Product])[];
  readonly onSelect: (product: Product) => void;
}): (product: Product) => void {
  function positionMenu(): void {
    const bounds = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(16, Math.min(bounds.left, window.innerWidth - menu.offsetWidth - 16))}px`;
    menu.style.top = `${bounds.bottom + 12}px`;
    menu.style.maxHeight = `${Math.max(0, window.innerHeight - bounds.bottom - 28)}px`;
  }

  menu.addEventListener('toggle', () => {
    const open = menu.matches(':popover-open');
    trigger.setAttribute('aria-expanded', String(open));
    if (!open) return;
    positionMenu();
    const selected = items.find(
      ([button]) => button.getAttribute('aria-checked') === 'true',
    );
    (selected ?? items[0])?.[0].focus();
  });

  window.addEventListener('resize', () => {
    if (menu.matches(':popover-open')) positionMenu();
  });

  trigger.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    menu.showPopover();
  });

  for (const [index, [button, product]] of items.entries()) {
    button.addEventListener('click', () => {
      onSelect(product);
      menu.hidePopover();
      trigger.focus();
    });
    button.addEventListener('keydown', (event) => {
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : event.key === 'ArrowDown'
              ? (index + 1) % items.length
              : event.key === 'ArrowUp'
                ? (index + items.length - 1) % items.length
                : -1;
      const target = items[next];
      if (!target) return;
      event.preventDefault();
      target[0].focus();
    });
  }

  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') menu.hidePopover();
  });

  return (product) => {
    for (const [button, value] of items) {
      const selected = value === product;
      button.setAttribute('aria-checked', String(selected));
      if (!selected) continue;
      const name = button.textContent?.trim() ?? '';
      label.textContent = name;
      trigger.setAttribute('aria-label', `Choose map type: ${name}`);
    }
  };
}
