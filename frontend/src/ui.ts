// Generic UI helpers: modal dialogs, context menu, toast.

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

let modalDepth = 0;
export const isModalOpen = () => modalDepth > 0;

export interface ModalButton { label: string; value: string; primary?: boolean; danger?: boolean }

/** Shows a modal; resolves with the clicked button value, or null on Esc / cancel. */
export function openModal(title: string, body: HTMLElement, buttons: ModalButton[],
  validate?: (value: string) => boolean | Promise<boolean>): Promise<string | null> {
  return new Promise(resolve => {
    const prevFocus = document.activeElement as HTMLElement | null;
    modalDepth++;
    const close = (v: string | null) => {
      modalDepth--;
      overlay.remove();
      prevFocus?.focus?.();
      resolve(v);
    };
    const click = async (b: ModalButton) => {
      if (validate && !(await validate(b.value))) return;
      close(b.value);
    };
    const btnRow = h('div', { class: 'modal-buttons' },
      ...buttons.map(b => h('button', {
        class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''),
        onclick: () => click(b),
      }, b.label)));
    const box = h('div', { class: 'modal' }, h('div', { class: 'modal-title' }, title), body, btnRow);
    const overlay = h('div', { class: 'modal-overlay' }, box);
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const p = buttons.find(b => b.primary);
        if (p) { e.preventDefault(); e.stopPropagation(); click(p); }
      }
    });
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(null); });
    document.body.append(overlay);
    const first = box.querySelector<HTMLElement>('input:not([type=checkbox]), select, textarea') ||
      box.querySelector<HTMLElement>('.btn.primary');
    setTimeout(() => {
      first?.focus();
      if (first instanceof HTMLInputElement) first.select();
    }, 0);
  });
}

export async function promptText(title: string, label: string, value = '', selectStem = false): Promise<string | null> {
  const input = h('input', { type: 'text', value, spellcheck: 'false' });
  const body = h('div', { class: 'form' }, h('label', {}, label, input));
  if (selectStem) {
    setTimeout(() => {
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value.length);
    }, 10);
  }
  const r = await openModal(title, body, [{ label: 'Batal', value: 'cancel' }, { label: 'OK', value: 'ok', primary: true }]);
  if (r !== 'ok') return null;
  return input.value.trim() || null;
}

export async function confirmDialog(title: string, message: string, okLabel = 'OK', danger = false): Promise<boolean> {
  const body = h('div', { class: 'modal-text' });
  body.textContent = message;
  const r = await openModal(title, body, [
    { label: 'Batal', value: 'cancel' },
    { label: okLabel, value: 'ok', primary: true, danger },
  ]);
  return r === 'ok';
}

export interface MenuItem { label?: string; icon?: string; action?: () => void; disabled?: boolean; sep?: boolean; hint?: string }

let openMenu: HTMLElement | null = null;
export function closeMenu() { openMenu?.remove(); openMenu = null; }

export function contextMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu();
  const menu = h('div', { class: 'ctx-menu' });
  for (const it of items) {
    if (it.sep) { menu.append(h('div', { class: 'ctx-sep' })); continue; }
    const row = h('div', { class: 'ctx-item' + (it.disabled ? ' disabled' : '') },
      h('span', { class: 'ctx-icon', html: it.icon || '' }),
      h('span', { class: 'ctx-label' }, it.label || ''),
      it.hint ? h('span', { class: 'ctx-hint' }, it.hint) : null);
    if (!it.disabled) row.addEventListener('click', () => { closeMenu(); it.action?.(); });
    menu.append(row);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
  openMenu = menu;
}
window.addEventListener('mousedown', e => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenu();
}, true);
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); }, true);
window.addEventListener('blur', closeMenu);

const toastIcons = {
  success: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  error: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
};

/** Small notification in the top-right corner. */
export function toast(msg: string, kind: 'info' | 'success' | 'error' = 'info') {
  let box = document.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts' }); document.body.append(box); }
  // Keep at most 4 visible; drop the oldest.
  while (box.children.length >= 4) box.firstElementChild!.remove();
  const t = h('div', { class: 'toast ' + kind },
    h('span', { class: 'toast-icon', html: toastIcons[kind] }), h('span', {}, msg));
  t.addEventListener('click', () => t.remove());
  box.append(t);
  setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 250); }, kind === 'error' ? 6000 : 2200);
}

export function errMsg(e: unknown): string {
  const s = typeof e === 'string' ? e : (e as any)?.message ?? String(e);
  return s.startsWith('auth:') ? s.slice(5) : s;
}

export function fmtSize(n: number): string {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}

export function fmtDate(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
