// First-run environment check: lists optional programs, installs missing ones
// with winget after one click, and offers the one-time login for AI CLIs.
import { CheckDeps, GetVersion, InstallDep, LoginAI, MarkSetupDone } from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';
import { store } from './state';
import { errMsg, h, openModal, toast } from './ui';

interface Dep { id: string; name: string; purpose: string; status: string; detail: string; installable: boolean; needsLogin: boolean; manual: string }

let logSink: ((id: string, line: string) => void) | null = null;
EventsOn('dep:log', (ev: { id: string; line: string }) => logSink?.(ev.id, ev.line));

/** Called after something was installed so panels can refresh. */
export const setupHooks = { changed: () => {} };

/** Shows the environment dialog. `focus` pre-selects one dependency. */
export async function showSetup(firstRun = false, focus = '') {
  const deps = (await CheckDeps()) as Dep[];
  const checks = new Map<string, HTMLInputElement>();
  const rows = h('div', { class: 'dep-list' });
  const log = h('pre', { class: 'dep-log hidden' });
  let installing = false;

  const render = (list: Dep[]) => {
    rows.replaceChildren(...list.map(d => {
      const icon = d.status === 'missing' ? '✗' : '✓';
      const cls = d.status === 'missing' ? 'missing' : 'ok';
      let action: HTMLElement | null = null;
      if (d.status === 'missing' && d.installable) {
        const cb = h('input', { type: 'checkbox', checked: firstRun || d.id === focus || !focus });
        checks.set(d.id, cb);
        action = h('label', { class: 'dep-check' }, cb, 'Pasang');
      } else if (d.status === 'missing') {
        action = h('span', { class: 'dep-manual' }, d.manual);
      } else if (d.needsLogin) {
        action = h('button', { class: 'btn small', title: 'Buka jendela login (sekali saja)', onclick: () => LoginAI(d.id).catch(e => toast(errMsg(e), 'error')) }, 'Login');
      }
      return h('div', { class: 'dep-row ' + cls + (d.id === focus ? ' focus' : '') },
        h('span', { class: 'dep-icon' }, icon),
        h('div', { class: 'dep-text' },
          h('b', {}, d.name),
          h('small', {}, d.purpose + (d.status === 'ok' && d.detail ? ` — ${d.detail}` : d.status === 'missing' ? ' — fitur ini nonaktif sampai dipasang' : ''))),
        action);
    }));
  };
  render(deps);

  const missing = deps.filter(d => d.status === 'missing' && d.installable);
  const body = h('div', { class: 'form' },
    h('div', { class: 'modal-text' }, firstRun
      ? 'Selamat datang! Aplikasi memeriksa program pendukung. Fitur bawaan langsung bisa dipakai; fitur yang programnya belum ada akan nonaktif sampai dipasang.'
      : 'Status program pendukung. Yang dicentang akan dipasang otomatis memakai winget.'),
    rows, log);

  const buttons = [
    { label: firstRun ? 'Lewati' : 'Tutup', value: 'close' },
    ...(missing.length ? [{ label: 'Pasang yang dicentang', value: 'install', primary: true }] : [{ label: 'OK', value: 'close', primary: true }]),
  ];
  const version = await GetVersion().catch(() => '');
  await openModal(`Program pendukung — Remote Terminal ${version}`, body, buttons, async v => {
    if (v !== 'install') return !installing;
    if (installing) return false;
    const todo = [...checks].filter(([, cb]) => cb.checked).map(([id]) => id);
    if (!todo.length) return true;
    installing = true;
    log.classList.remove('hidden');
    log.textContent = '';
    logSink = (id, line) => { log.textContent += `[${id}] ${line}\n`; log.scrollTop = log.scrollHeight; };
    for (const id of todo) {
      log.textContent += `── Memasang ${deps.find(d => d.id === id)?.name} …\n`;
      try {
        await InstallDep(id);
        log.textContent += `✓ ${id} terpasang\n`;
        toast(`${deps.find(d => d.id === id)?.name} terpasang`, 'success');
      } catch (e) {
        log.textContent += `✗ ${id}: ${errMsg(e)}\n`;
        toast(`Gagal memasang ${id}: ${errMsg(e)}`, 'error');
      }
    }
    logSink = null;
    installing = false;
    checks.clear();
    const fresh = (await CheckDeps()) as Dep[];
    render(fresh);
    setupHooks.changed();
    const loginNeeded = fresh.filter(d => todo.includes(d.id) && d.status === 'ok' && d.needsLogin);
    if (loginNeeded.length) log.textContent += `\nKlik "Login" pada ${loginNeeded.map(d => d.name).join(' dan ')} untuk login sekali.\n`;
    return false; // keep the dialog open to show results
  });
  if (firstRun && !store.settings.setupDone) {
    store.settings.setupDone = true;
    MarkSetupDone();
  }
  setupHooks.changed();
}
