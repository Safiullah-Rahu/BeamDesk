/**
 * BeamDesk desktop app (Electron main process).
 *
 * The UI is the same web app the browser version uses, loaded from a privileged
 * app:// origin. This process adds what browsers cannot do: capture any screen,
 * inject mouse/keyboard input, write files to disk, live in the tray and start at login.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerSaveBlocker,
  protocol,
  screen,
  session,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { secureStorageAvailable, SettingsStore } from './store.ts';
import { handleInput, inputAvailable, isWayland, releaseAll } from './input.ts';
import { abortAll, abortFile, closeFile, createdFiles, openFile, writeFile } from './files.ts';
import { adminConfig, lockScreen, openPermissionSettings, permissions, setLaunchAtLogin, startedHidden } from './system.ts';
import { HostServer } from './hostserver.ts';
import { PinnedSockets } from './pinnedsocket.ts';

declare const __BEAMDESK_SERVER__: string;

const ORIGIN = 'app://beamdesk';
const WEB_DIR = path.join(__dirname, '..', 'web');
const ICON = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
// Development only: a packaged app never loads its UI (and bridge) from anywhere else.
const DEV_URL = app.isPackaged ? undefined : process.env.BEAMDESK_DEV_URL;
const DEV_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : null;

/** Exact origin comparison (a prefix check would accept "app://beamdesk.evil" or "localhost:5173.evil"). */
function ownOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'app:') return u.host === 'beamdesk';
    return !!DEV_ORIGIN && u.origin === DEV_ORIGIN;
  } catch {
    return false;
  }
}

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  // The signaling server is user-configurable (ws:// on a LAN, wss:// on the internet).
  "connect-src 'self' ws: wss: http: https:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

// One BeamDesk per user: a second launch (or a beamdesk:// link) focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('beamdesk', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('beamdesk');
}

// Keep capture and encoding running at full speed when the window is hidden.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

const store = new SettingsStore();
const admin = adminConfig();
const defaultServer = admin.serverUrl || process.env.BEAMDESK_SERVER_URL || __BEAMDESK_SERVER__;
if (admin.accessKey) {
  const s = store.get<Record<string, unknown>>('settings') ?? {};
  if (!s.accessKey) store.set('settings', { ...s, accessKey: admin.accessKey });
}

let main: BrowserWindow | null = null;
let bar: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let pendingLinks: string[] = [];
let rendererReady = false;
let trayStatus = { id: '', sessions: 0, online: false };
let blocker: number | null = null;
/** Number of hosted sessions that currently allow remote control (reported with the session bar). */
let controlSessions = 0;
let hadSessions = false;

function validDir(p: unknown): string | null {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  try {
    return fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}
let downloadsDir = validDir(store.get<string>('downloadsDir')) ?? path.join(app.getPath('downloads'), 'BeamDesk');

/** Stored values only the main process may change or read (the UI goes through their own IPC). */
const MAIN_ONLY_DATA = new Set(['downloadsDir', 'hostMode']);
const MAIN_ONLY_SECRETS = new Set(['hostSecrets']);

const hostServer = new HostServer({
  store,
  webRoot: WEB_DIR,
  onChange: (info) => {
    main?.webContents.send('hostmode:state', info);
    updateTray();
  },
});
const pinnedSockets = new PinnedSockets((host) => hostServer.pinFor(host));

const minimizeToTray = () => (store.get<Record<string, unknown>>('settings')?.minimizeToTray ?? true) !== false;

function linkFromArgv(argv: string[]): string | undefined {
  return argv.find((a) => a.startsWith('beamdesk:'));
}

function deliverLink(url: string): void {
  if (!/^beamdesk:/.test(url) || url.length > 2048) return;
  if (main && rendererReady) main.webContents.send('deep-link', url);
  else pendingLinks.push(url);
  showMain();
}

function showMain(): void {
  if (!main) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
}

function webPreferences(): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
    backgroundThrottling: false,
  };
}

function createMainWindow(): void {
  const hidden = startedHidden();
  main = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: 'BeamDesk',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  });
  void main.loadURL(DEV_URL ?? `${ORIGIN}/index.html`);
  main.once('ready-to-show', () => {
    if (!hidden) main?.show();
  });
  main.webContents.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) pinnedSockets.closeAll(main!.webContents);
  });
  main.webContents.on('did-finish-load', () => {
    rendererReady = true;
    for (const link of pendingLinks.splice(0)) main?.webContents.send('deep-link', link);
  });
  main.webContents.on('render-process-gone', (_e, d) => {
    console.error('[main] renderer gone', d.reason);
    if (main) pinnedSockets.closeAll(main.webContents);
    releaseAll();
    // The sessions died with the renderer, which can no longer lock the screen as configured.
    if (hadSessions && store.get<Record<string, unknown>>('settings')?.lockOnEnd) void lockScreen();
    controlSessions = 0;
    hadSessions = false;
    bar?.hide();
    rendererReady = false;
    if (!quitting) main?.reload();
  });
  main.on('close', (e) => {
    if (!quitting && minimizeToTray() && tray) {
      e.preventDefault();
      main?.hide();
      if (process.platform === 'darwin') app.dock?.hide();
    }
  });
  main.on('show', () => {
    if (process.platform === 'darwin') void app.dock?.show();
  });
  main.on('closed', () => {
    main = null;
  });
}

function createSessionBar(): BrowserWindow {
  const display = screen.getPrimaryDisplay().workArea;
  const width = 440;
  const w = new BrowserWindow({
    width,
    height: 44,
    x: Math.round(display.x + (display.width - width) / 2),
    y: display.y + 8,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: true,
    webPreferences: webPreferences(),
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep the reminder bar out of the shared video (Windows/macOS).
  w.setContentProtection(true);
  void w.loadURL(DEV_URL ? `${DEV_URL}#session-bar` : `${ORIGIN}/index.html#session-bar`);
  w.on('closed', () => (bar = null));
  return w;
}

function hostLabel(): string {
  const h = hostServer.info();
  if (h.phase === 'running') return `Server on · ${h.status?.devices ?? 0} device${h.status?.devices === 1 ? '' : 's'}`;
  if (h.phase === 'starting') return 'Server starting…';
  if (h.phase === 'error') return 'Server could not start';
  return '';
}

function updateTray(): void {
  if (!tray) return;
  const { id, sessions, online } = trayStatus;
  const pretty = id.replace(/(\d{3})(?=\d)/g, '$1 ');
  const host = hostServer.info();
  const hostLine = hostLabel();
  tray.setToolTip(`BeamDesk${pretty ? ` — ID ${pretty}` : ''}${sessions ? ` — ${sessions} connected` : ''}${online ? '' : ' (offline)'}${hostLine ? ` — ${hostLine}` : ''}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open BeamDesk', click: showMain },
      { label: pretty ? `Copy my ID (${pretty})` : 'Copy my ID', enabled: !!id, click: () => clipboard.writeText(id) },
      { type: 'separator' },
      {
        label: 'Host mode (this computer is the server)',
        type: 'checkbox',
        checked: host.config.enabled,
        click: (item) => void hostServer.set({ enabled: item.checked }),
      },
      ...(hostLine ? [{ label: hostLine, enabled: false }] : []),
      ...(host.status?.code ? [{ label: 'Copy connection code', click: () => clipboard.writeText(host.status!.code) }] : []),
      { type: 'separator' },
      { label: sessions ? `End ${sessions} session${sessions > 1 ? 's' : ''}` : 'No active sessions', enabled: sessions > 0, click: () => main?.webContents.send('session-bar:action', { type: 'end-all' }) },
      { type: 'separator' },
      {
        label: 'Quit BeamDesk',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray(): void {
  try {
    let image = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'tray.png'));
    if (image.isEmpty()) image = nativeImage.createFromPath(ICON);
    if (image.isEmpty()) return;
    if (process.platform === 'darwin') {
      image = image.resize({ width: 18, height: 18 });
    } else {
      image = image.resize({ width: 24, height: 24 });
    }
    tray = new Tray(image);
    tray.on('click', showMain);
    updateTray();
  } catch (err) {
    console.warn('[main] tray unavailable', err);
  }
}

/** Only our own UI may use the bridge. */
function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  // Top-level frames of our own windows only.
  return !!frame && frame.parent === null && ownOrigin(frame.url);
}

function registerIpc(): void {
  const on = (ch: string, fn: (e: IpcMainEvent, ...args: any[]) => void) =>
    ipcMain.on(ch, (e, ...args) => {
      if (trusted(e)) fn(e, ...args);
    });
  const handle = (ch: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) =>
    ipcMain.handle(ch, (e, ...args) => {
      if (!trusted(e)) throw new Error('forbidden');
      return fn(e, ...args);
    });

  on('store:load', (e) => (e.returnValue = store.load(MAIN_ONLY_SECRETS)));
  on('store:set', (_e, key, value) => {
    // Where files are written is decided in the main process (folder picker) only: a page that
    // could set it could drop received files into e.g. the Startup folder. Host mode settings
    // are validated by their own handler.
    if (MAIN_ONLY_DATA.has(key)) return;
    store.set(key, value);
    if (key === 'settings' && value && typeof value === 'object') setLaunchAtLogin(!!(value as any).launchAtLogin);
  });
  on('store:secret', (_e, key, value) => {
    if (MAIN_ONLY_SECRETS.has(key)) return;
    store.setSecret(key, value);
    // The home server this device joined: accept its certificate from now on.
    if (key === 'homeServer') hostServer.updatePins();
  });
  on('hostmode:get', (e) => (e.returnValue = hostServer.info()));
  handle('hostmode:set', (_e, patch) => hostServer.set(patch));
  handle('hostmode:regenerate', () => hostServer.regenerate());
  on('hostmode:refresh', () => hostServer.refresh());
  handle('pws:open', (e, url) => pinnedSockets.open(e.sender, url));
  on('pws:send', (e, id, data) => pinnedSockets.send(e.sender, id, data));
  on('pws:close', (e, id, code, reason) => pinnedSockets.close(e.sender, id, code, reason));
  on('app:info', (e) => (e.returnValue = { version: app.getVersion(), os: process.platform, defaultServer, wayland: isWayland, inputAvailable: inputAvailable(), secureStorage: secureStorageAvailable() }));

  handle('displays', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    return sources.map((s, i) => {
      const d = displays.find((x) => String(x.id) === s.display_id) ?? displays[i] ?? primary;
      return {
        id: String(d.id),
        sourceId: s.id,
        name: displays.length > 1 ? `${d.id === primary.id ? 'Main display' : `Display ${i + 1}`}` : 'Screen',
        width: Math.round(d.size.width * d.scaleFactor),
        height: Math.round(d.size.height * d.scaleFactor),
        primary: d.id === primary.id,
      };
    });
  });

  // Input is only injected while a session that allows control is shown in the session bar.
  on('input', (_e, displayId, cmd) => {
    if (cmd?.k === 'release' || controlSessions > 0) handleInput(displayId, cmd);
  });

  handle('clipboard:read', () => clipboard.readText());
  handle('clipboard:write', (_e, text) => {
    if (typeof text === 'string' && text.length <= 1_000_000) clipboard.writeText(text);
  });

  handle('file:open', (_e, name, size) => openFile(downloadsDir, name, size));
  handle('file:write', (_e, id, chunk) => writeFile(Number(id), chunk));
  handle('file:close', (_e, id) => closeFile(Number(id)));
  on('file:abort', (_e, id) => abortFile(Number(id)));
  on('reveal', (_e, p) => {
    if (typeof p === 'string' && createdFiles.has(p)) shell.showItemInFolder(p);
  });
  on('downloads:get', (e) => (e.returnValue = downloadsDir));
  handle('downloads:choose', async () => {
    const r = await dialog.showOpenDialog(main!, { title: 'Save received files to', defaultPath: downloadsDir, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    downloadsDir = r.filePaths[0];
    store.set('downloadsDir', downloadsDir);
    return downloadsDir;
  });

  on('tray', (_e, status) => {
    if (!status || typeof status !== 'object') return;
    trayStatus = { id: String(status.id ?? ''), sessions: Number(status.sessions) || 0, online: !!status.online };
    updateTray();
  });
  on('session-bar', (_e, state) => {
    const sessions = (Array.isArray(state?.sessions) ? state.sessions : []).slice(0, 32);
    controlSessions = sessions.filter((s: { control?: unknown }) => s?.control === true).length;
    if (!controlSessions) releaseAll();
    if (sessions.length) {
      hadSessions = true;
      bar ??= createSessionBar();
      const send = () => bar?.webContents.send('session-bar:state', { sessions });
      if (bar.webContents.isLoading()) bar.webContents.once('did-finish-load', send);
      else send();
      bar.showInactive();
      blocker ??= powerSaveBlocker.start('prevent-display-sleep');
    } else {
      hadSessions = false;
      bar?.hide();
      releaseAll();
      if (blocker !== null) powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  });
  on('session-bar:action', (_e, action) => {
    if (action?.type === 'show') showMain();
    main?.webContents.send('session-bar:action', action);
  });
  on('login-item', (_e, enabled) => setLaunchAtLogin(!!enabled));
  on('lock', () => void lockScreen());
  handle('permissions', () => permissions());
  on('open-permission', (_e, kind) => openPermissionSettings(kind === 'accessibility' ? 'accessibility' : 'screen'));
  on('attention', () => {
    if (!main) return;
    if (!main.isVisible() || main.isMinimized()) showMain();
    main.flashFrame(true);
    setTimeout(() => main?.flashFrame(false), 4000);
  });
  on('notify', (_e, title, body) => {
    if (Notification.isSupported() && typeof title === 'string') {
      const n = new Notification({ title: title.slice(0, 120), body: String(body ?? '').slice(0, 300), icon: fs.existsSync(ICON) ? ICON : undefined });
      n.on('click', showMain);
      n.show();
    }
  });
  on('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) void shell.openExternal(url);
  });
  on('quit', () => {
    quitting = true;
    app.quit();
  });
}

function hardenSessions(): void {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'pointerLock', 'keyboardLock']);
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission) && ownOrigin(wc.getURL())));
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && ownOrigin(origin));
  ses.on('will-download', (_e, item) => {
    // Screenshots and recordings go straight to the downloads folder.
    fs.mkdirSync(downloadsDir, { recursive: true });
    const name = path.basename(item.getFilename()).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'download';
    let target = path.join(downloadsDir, name);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(downloadsDir, `${path.parse(name).name} (${i})${path.extname(name)}`);
    item.setSavePath(target);
    item.once('done', (_ev, state) => {
      if (state === 'completed') createdFiles.add(target);
    });
  });
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e, url) => {
    if (!ownOrigin(url)) e.preventDefault();
  });
  contents.on('will-redirect', (e, url) => {
    if (!ownOrigin(url)) e.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.on('second-instance', (_e, argv) => {
  const link = linkFromArgv(argv);
  if (link) deliverLink(link);
  else showMain();
});

app.on('open-url', (e, url) => {
  e.preventDefault();
  deliverLink(url);
});

app.on('before-quit', () => {
  quitting = true;
  releaseAll();
  abortAll();
  store.flush();
});

// Turning the server off removes the router's port forwarding: wait for that (a few seconds at
// most). Windows are closed and settings saved by now; a second app.quit() would not exit here.
let hostStopping = false;
app.on('will-quit', (e) => {
  if (hostServer.info().phase === 'off') return;
  e.preventDefault();
  if (hostStopping) return;
  hostStopping = true;
  void hostServer.shutdown().finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || !tray) app.quit();
});

app.on('activate', () => {
  if (main) showMain();
  else createMainWindow();
});

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'beamdesk') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(WEB_DIR, rel));
    if (!file.startsWith(WEB_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString()).catch(() => null);
    if (!res || !res.ok) return new Response('Not found', { status: 404 });
    const headers = new Headers(res.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    // The UI has the native bridge: no inline or remote code, ever.
    headers.set('Content-Security-Policy', APP_CSP);
    return new Response(res.body, { status: 200, headers });
  });
  hardenSessions();
  hostServer.init();
  registerIpc();
  createMainWindow();
  createTray();
  const link = linkFromArgv(process.argv);
  if (link) deliverLink(link);
  const s = store.get<Record<string, unknown>>('settings');
  setLaunchAtLogin(s ? !!s.launchAtLogin : true);
});
