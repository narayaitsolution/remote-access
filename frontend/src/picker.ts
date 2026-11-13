// Server picker shown in every new tab / split, plus profile editor and password prompt.
import { DeleteProfile, MoveProfile, PickKeyFile, SaveProfile } from '../wailsjs/go/main/App';
import { main } from '../wailsjs/go/models';
import { icons } from './icons';
import { refreshState, store, type ProfileView } from './state';
import { confirmDialog, errMsg, h, openModal, toast } from './ui';

export class Picker {
  el: HTMLElement;
  private search: HTMLInputElement;
  private list: HTMLElement;
  private sel = 0;
  private shown: ProfileView[] = [];
  private unsub: () => void;

  constructor(private onConnect: (p: ProfileView) => void) {
    this.search = h('input', { class: 'picker-search', type: 'text', placeholder: 'Cari server…', spellcheck: 'false' });
    this.list = h('div', { class: 'picker-list', tabindex: '-1' });
    const newBtn = h('button', { class: 'btn primary', html: icons.plus + '<span>Server baru</span>', onclick: () => this.edit(null) });
    this.el = h('div', { class: 'picker' },
      h('div', { class: 'picker-card' },
        h('div', { class: 'picker-head' }, h('div', { class: 'picker-title' }, 'Pilih server'), newBtn),
        this.search,
        this.list,
        h('div', { class: 'picker-hint' }, '↑↓ pilih · Enter konek · Ctrl+N server baru · Ctrl+E edit · Del hapus')));
    this.search.addEventListener('input', () => { this.sel = 0; this.render(); });
    this.el.addEventListener('keydown', e => this.onKey(e));
    const f = () => this.render();
    store.listeners.add(f);
    this.unsub = () => store.listeners.delete(f);
    this.render();
  }

  focus() { this.search.focus(); }
  dispose() { this.unsub(); this.el.remove(); }

  private onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { this.sel = Math.min(this.sel + 1, this.shown.length - 1); this.render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { this.sel = Math.max(this.sel - 1, 0); this.render(); e.preventDefault(); }
    else if (e.key === 'Enter' && this.shown[this.sel]) { e.preventDefault(); this.onConnect(this.shown[this.sel]); }
    else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); this.edit(null); }
    else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'e' && this.shown[this.sel]) { e.preventDefault(); this.edit(this.shown[this.sel]); }
    else if (e.key === 'Delete' && this.shown[this.sel] && this.search.value === '') { e.preventDefault(); this.remove(this.shown[this.sel]); }
  }

  render() {
    const q = this.search.value.trim().toLowerCase();
    this.shown = store.profiles.filter(p => !q ||
      `${p.name} ${p.user}@${p.host}`.toLowerCase().includes(q));
    if (this.sel >= this.shown.length) this.sel = Math.max(0, this.shown.length - 1);
    this.list.innerHTML = '';
    if (store.profiles.length === 0) {
      this.list.append(h('div', { class: 'picker-empty' }, 'Belum ada server. Klik "Server baru" untuk menambahkan.'));
      return;
    }
    if (this.shown.length === 0) {
      this.list.append(h('div', { class: 'picker-empty' }, 'Tidak ada yang cocok.'));
      return;
    }
    this.shown.forEach((p, i) => {
      const act = (icon: string, title: string, fn: () => void) =>
        h('button', { class: 'icon-btn', title, html: icon, onclick: (e: MouseEvent) => { e.stopPropagation(); fn(); } });
      const row = h('div', { class: 'picker-row' + (i === this.sel ? ' sel' : '') },
        h('span', { class: 'picker-icon', html: icons.server }),
        h('div', { class: 'picker-text' },
          h('div', { class: 'picker-name' }, p.name),
          h('div', { class: 'picker-sub' }, `${p.user}@${p.host}${p.port !== 22 ? ':' + p.port : ''}` +
            (p.tmuxSession ? `  · tmux: ${p.tmuxSession}` : '') + (p.authType === 'key' ? `  · key: ${p.keyPath.split(/[\\/]/).pop()}` : p.hasPassword ? '' : '  · password ditanya'))),
        h('div', { class: 'picker-actions' },
          act(icons.arrowUp, 'Pindah ke atas', () => MoveProfile(p.id, -1).then(refreshState)),
          act(icons.arrowDown, 'Pindah ke bawah', () => MoveProfile(p.id, 1).then(refreshState)),
          act(icons.edit, 'Edit', () => this.edit(p)),
          act(icons.copy, 'Duplikat', () => this.edit({ ...p, id: '', name: p.name + ' (salinan)', hasPassword: false })),
          act(icons.del, 'Hapus', () => this.remove(p))));
      row.addEventListener('click', () => { this.sel = i; this.render(); this.search.focus(); });
      row.addEventListener('dblclick', () => this.onConnect(p));
      this.list.append(row);
    });
    this.list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }

  private async remove(p: ProfileView) {
    if (await confirmDialog('Hapus server', `Hapus profil "${p.name}"?`, 'Hapus', true)) {
      await DeleteProfile(p.id);
      await refreshState();
    }
  }

  private async edit(p: ProfileView | null) {
    const saved = await editProfile(p);
    if (saved) {
      await refreshState();
      this.sel = Math.max(0, store.profiles.findIndex(x => x.id === saved.id));
      this.render();
    }
    this.search.focus();
  }
}

export async function editProfile(p: ProfileView | null): Promise<ProfileView | null> {
  const isEdit = !!p?.id;
  const f = (label: string | Node, input: HTMLElement, hint?: string) =>
    h('label', {}, label, input, hint ? h('small', {}, hint) : null);
  const name = h('input', { type: 'text', value: p?.name ?? '', placeholder: 'contoh: Server Produksi' });
  const host = h('input', { type: 'text', value: p?.host ?? '', placeholder: 'IP atau hostname', spellcheck: 'false' });
  const port = h('input', { type: 'number', value: String(p?.port ?? 22), min: '1', max: '65535' });
  const user = h('input', { type: 'text', value: p?.user ?? '', spellcheck: 'false' });

  // Login method: password or SSH key.
  const origAuth = p?.authType === 'key' ? 'key' : 'password';
  let auth: 'password' | 'key' = origAuth;
  const authBtn = (v: 'password' | 'key', label: string) =>
    h('button', { type: 'button', class: 'seg-btn', onclick: () => { auth = v; syncAuth(); } }, label);
  const btnPw = authBtn('password', 'Password'), btnKey = authBtn('key', 'SSH key');
  const keyPath = h('input', { type: 'text', value: p?.keyPath ?? '', placeholder: 'C:\Users\…\.ssh\id_ed25519', spellcheck: 'false' });
  const browse = h('button', { type: 'button', class: 'btn', onclick: async () => {
    const f = await PickKeyFile().catch(() => '');
    if (f) keyPath.value = f;
  } }, 'Pilih…');
  const keyRow = h('label', {}, 'File private key', h('div', { class: 'input-row' }, keyPath, browse),
    h('small', {}, 'Format OpenSSH/PEM (id_rsa, id_ed25519, …). File .ppk perlu di-export ke OpenSSH dulu lewat PuTTYgen.'));
  const passLabel = h('span', {});
  const pass = h('input', { type: 'password' });
  const save = h('input', { type: 'checkbox', checked: p ? p.hasPassword : true });
  const saveLabel = h('span', {});
  const syncAuth = () => {
    btnPw.classList.toggle('on', auth === 'password');
    btnKey.classList.toggle('on', auth === 'key');
    keyRow.classList.toggle('hidden', auth !== 'key');
    const stored = p?.hasPassword && auth === origAuth;
    if (auth === 'key') {
      passLabel.textContent = 'Passphrase key (kosongkan jika key tidak dipassword)';
      saveLabel.textContent = 'Simpan passphrase (terenkripsi untuk user Windows ini)';
    } else {
      passLabel.textContent = 'Password';
      saveLabel.textContent = 'Simpan password (terenkripsi untuk user Windows ini)';
    }
    pass.placeholder = stored ? '(tersimpan — kosongkan agar tidak berubah)' : '';
  };
  syncAuth();

  const tmux = h('input', { type: 'text', value: p?.tmuxSession ?? '', placeholder: 'kosong = shell biasa', spellcheck: 'false' });
  const err = h('div', { class: 'form-error' });
  const body = h('div', { class: 'form' },
    f('Nama', name),
    h('div', { class: 'form-row' }, f('Host', host), f('Port', port)),
    f('User', user),
    h('label', {}, 'Metode login', h('div', { class: 'seg' }, btnPw, btnKey)),
    keyRow,
    f(passLabel, pass),
    h('label', { class: 'check' }, save, saveLabel),
    f('Sesi tmux otomatis (opsional)', tmux, 'Jika diisi, saat konek langsung masuk/membuat sesi tmux dengan nama ini.'),
    err);
  let result: ProfileView | null = null;
  const r = await openModal(isEdit ? 'Edit server' : 'Server baru', body,
    [{ label: 'Batal', value: 'cancel' }, { label: 'Simpan', value: 'ok', primary: true }],
    async v => {
      if (v !== 'ok') return true;
      try {
        const keep = isEdit && p!.hasPassword && auth === origAuth && save.checked && pass.value === '';
        result = await SaveProfile(main.ProfileInput.createFrom({
          id: isEdit ? p!.id : '', name: name.value, host: host.value, port: Number(port.value) || 22,
          user: user.value, password: pass.value, savePassword: save.checked, keepPassword: keep,
          authType: auth, keyPath: keyPath.value, tmuxSession: tmux.value,
        })) as unknown as ProfileView;
        return true;
      } catch (e) {
        err.textContent = errMsg(e);
        return false;
      }
    });
  if (r === 'ok' && result) toast('Server disimpan', 'success');
  return r === 'ok' ? result : null;
}

/** Asks for the password, or for the key passphrase on SSH-key profiles. */
export async function askPassword(p: ProfileView, error = ''): Promise<{ password: string; save: boolean } | null> {
  const isKey = p.authType === 'key';
  const pass = h('input', { type: 'password' });
  const save = h('input', { type: 'checkbox' });
  const body = h('div', { class: 'form' },
    error ? h('div', { class: 'form-error' }, error) : null,
    h('label', {}, isKey ? `Passphrase untuk key ${p.keyPath.split(/[\/]/).pop()}` : `Password untuk ${p.user}@${p.host}`, pass),
    h('label', { class: 'check' }, save, isKey ? 'Simpan passphrase (terenkripsi)' : 'Simpan password (terenkripsi)'));
  const r = await openModal('Login', body,
    [{ label: 'Batal', value: 'cancel' }, { label: 'Konek', value: 'ok', primary: true }]);
  if (r !== 'ok') return null;
  return { password: pass.value, save: save.checked };
}
