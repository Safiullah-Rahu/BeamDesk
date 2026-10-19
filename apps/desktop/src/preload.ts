/**
 * Preload script (sandboxed): exposes a small, explicit API to the UI as `window.beamdesk`.
 * No Node.js APIs are reachable from the page.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '@beamdesk/core/bridge';

const info = ipcRenderer.sendSync('app:info') as { version: string; os: string; defaultServer: string; wayland: boolean; inputAvailable: boolean; secureStorage: boolean };
const os = info.os === 'win32' ? 'windows' : info.os === 'darwin' ? 'macos' : 'linux';

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const fn = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

const bridge: DesktopBridge = {
  version: info.version,
  os,
  defaultServer: info.defaultServer || '',
  wayland: info.wayland,
  secureStorage: info.secureStorage,
  store: {
    load: () => ipcRenderer.sendSync('store:load'),
    set: (key, value) => ipcRenderer.send('store:set', key, value),
    setSecret: (key, value) => ipcRenderer.send('store:secret', key, value),
  },
  displays: () => ipcRenderer.invoke('displays'),
  input: (displayId, cmd) => ipcRenderer.send('input', displayId, cmd),
  inputAvailable: () => info.inputAvailable,
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text),
  fileOpen: (name, size) => ipcRenderer.invoke('file:open', name, size),
  fileWrite: (handle, chunk) => ipcRenderer.invoke('file:write', handle, chunk),
  fileClose: (handle) => ipcRenderer.invoke('file:close', handle),
  fileAbort: (handle) => ipcRenderer.send('file:abort', handle),
  revealFile: (path) => ipcRenderer.send('reveal', path),
  downloadsDir: () => ipcRenderer.sendSync('downloads:get'),
  chooseDownloadsDir: () => ipcRenderer.invoke('downloads:choose'),
  setLaunchAtLogin: (enabled) => ipcRenderer.send('login-item', enabled),
  setTrayStatus: (status) => ipcRenderer.send('tray', status),
  setSessionBar: (state) => ipcRenderer.send('session-bar', state),
  onSessionBarAction: (cb) => listen('session-bar:action', cb),
  onSessionBarState: (cb) => listen('session-bar:state', cb),
  sessionBarAction: (a) => ipcRenderer.send('session-bar:action', a),
  onDeepLink: (cb) => listen('deep-link', cb),
  lockScreen: () => ipcRenderer.send('lock'),
  permissions: () => ipcRenderer.invoke('permissions'),
  openPermissionSettings: (kind) => ipcRenderer.send('open-permission', kind),
  attention: () => ipcRenderer.send('attention'),
  notify: (title, body) => ipcRenderer.send('notify', title, body),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  quit: () => ipcRenderer.send('quit'),
};

contextBridge.exposeInMainWorld('beamdesk', bridge);
