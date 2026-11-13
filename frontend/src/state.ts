// Shared application state and cross-module hooks.
import { GetState, SaveSettings } from '../wailsjs/go/main/App';
import { main } from '../wailsjs/go/models';
import type { Pane } from './pane';

export interface ProfileView {
  id: string; name: string; host: string; port: number; user: string;
  hasPassword: boolean; authType: string; keyPath: string; tmuxSession: string;
}

export interface Settings {
  fontFamily: string; fontSize: number; scrollback: number; copyOnSelect: boolean;
  sidebarVisible: boolean; sidebarWidth: number; sidebarFollow: boolean;
  keepaliveSeconds: number; tmuxMouse: boolean; downloadDir: string;
  aiVisible: boolean; aiWidth: number; aiProvider: string; aiModels: Record<string, string>;
  keys: Record<string, string>;
}

export const store = {
  settings: {} as Settings,
  profiles: [] as ProfileView[],
  configPath: '',
  configError: '',
  listeners: new Set<() => void>(),
};

export async function refreshState() {
  const s = await GetState();
  store.settings = s.settings as unknown as Settings;
  store.profiles = (s.profiles || []) as unknown as ProfileView[];
  store.configPath = s.configPath;
  store.configError = s.configError;
  store.listeners.forEach(f => f());
}

let saveTimer = 0;
export function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => SaveSettings(main.Settings.createFrom(store.settings)), 600);
}

/** Hooks implemented by the layout controller (avoids circular imports). */
export const hooks = {
  paneChanged: (_p: Pane) => {},
  closePane: (_p: Pane) => {},
  focusPane: (_p: Pane) => {},
  activePane: (): Pane | null => null,
  allPanes: (): Pane[] => [],
  enterPressed: (_p: Pane) => {},
  paneFocused: (_p: Pane) => {},
  paneDisposed: (_p: Pane) => {},
  toggleAI: () => {},
  filesChanged: () => {},
};
