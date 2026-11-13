import '@xterm/xterm/css/xterm.css';
import './style.css';
import { HostKeyAnswer } from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';
import { AIPanel } from './ai';
import { Layout } from './layout';
import { Sidebar } from './sidebar';
import { hooks, refreshState, store } from './state';
import { h, openModal, toast } from './ui';

interface HostKeyPrompt { reqId: string; host: string; keyType: string; fingerprint: string; changed: boolean }

async function boot() {
  await refreshState();
  const sidebar = new Sidebar();
  const ai = new AIPanel();
  hooks.paneFocused = p => ai.bind(p);
  hooks.paneDisposed = p => ai.disposePane(p);
  hooks.toggleAI = () => ai.toggle();
  hooks.filesChanged = () => sidebar.refresh();
  const layout = new Layout(sidebar);
  document.getElementById('app')!.append(h('div', { class: 'root' }, sidebar.el, layout.el, ai.el));
  if (store.configError) toast(store.configError, 'error');

  EventsOn('hostkey', async (p: HostKeyPrompt) => {
    const body = h('div', { class: 'modal-text' });
    body.innerHTML = p.changed
      ? `<p class="warn"><b>PERINGATAN: host key server <code></code> BERUBAH.</b></p>
         <p>Ini bisa berarti server di-install ulang, atau ada pihak yang menyadap koneksi (man-in-the-middle).
         Terima hanya jika Anda yakin perubahan ini wajar.</p>`
      : `<p>Pertama kali terhubung ke <code></code>.</p><p>Pastikan fingerprint ini milik server Anda.</p>`;
    body.querySelector('code')!.textContent = p.host;
    body.append(h('div', { class: 'fingerprint' }, `${p.keyType}\n${p.fingerprint}`));
    const r = await openModal(p.changed ? 'Host key berubah' : 'Server baru', body, [
      { label: 'Tolak', value: 'no' },
      { label: p.changed ? 'Terima kunci baru' : 'Percaya & lanjutkan', value: 'yes', primary: !p.changed, danger: p.changed },
    ]);
    HostKeyAnswer(p.reqId, r === 'yes');
  });

  // Block browser behaviours that make no sense in a desktop app.
  window.addEventListener('keydown', e => {
    if (e.key === 'F5' && !(e.target as HTMLElement)?.closest?.('.term-host')) e.preventDefault();
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => e.preventDefault());
}

boot();
