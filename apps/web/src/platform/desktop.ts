/** Desktop (Electron) implementation, backed by the preload bridge `window.beamdesk`. */
import type { DesktopBridge, DisplayInfo, FileSinkFactory } from '@beamdesk/core';
import type { AppPlatform } from './types.ts';

declare const __DEFAULT_SERVER__: string;

export function createDesktopPlatform(bridge: DesktopBridge): AppPlatform {
  const persisted = bridge.store.load();
  const store = {
    data: persisted.data ?? {},
    secrets: persisted.secrets ?? {},
    set(key: string, value: unknown) {
      store.data[key] = value;
      bridge.store.set(key, value);
    },
    setSecret(key: string, value: string | null) {
      if (value === null) delete store.secrets[key];
      else store.secrets[key] = value;
      bridge.store.setSecret(key, value);
    },
  };

  const diskSink: FileSinkFactory = async (meta) => {
    const handle = await bridge.fileOpen(meta.name, meta.size);
    if (handle === null) return null;
    return {
      write: (chunk) => bridge.fileWrite(handle, chunk),
      close: () => bridge.fileClose(handle),
      abort: () => bridge.fileAbort(handle),
    };
  };

  let sourceIds = new Map<string, string>();
  const inputOk = bridge.inputAvailable();

  return {
    kind: 'desktop',
    os: bridge.os,
    defaultServer: bridge.defaultServer || __DEFAULT_SERVER__,
    store,
    host: {
      kind: 'desktop',
      capabilities: () => ({
        control: inputOk,
        audio: bridge.os === 'windows',
        files: true,
        clipboard: true,
        multiDisplay: true,
      }),
      async listDisplays(): Promise<DisplayInfo[]> {
        const list = await bridge.displays();
        sourceIds = new Map(list.map((d) => [d.id, d.sourceId]));
        return list.map(({ id, name, width, height, primary }) => ({ id, name, width, height, primary }));
      },
      async capture(displayId, opts) {
        if (!sourceIds.size) await this.listDisplays();
        const id = displayId && sourceIds.has(displayId) ? displayId : [...sourceIds.keys()][0];
        const sourceId = id ? sourceIds.get(id) : undefined;
        if (!sourceId) throw new Error('No screen available to share');
        const desktop = { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId };
        const constraints: any = {
          audio: opts.audio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
          video: { mandatory: { ...desktop, maxFrameRate: opts.fps, maxWidth: 7680, maxHeight: 4320 } },
        };
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
          if (!opts.audio) throw err;
          // System audio is not available everywhere; fall back to video only.
          stream = await navigator.mediaDevices.getUserMedia({ ...constraints, audio: false });
        }
        return { stream, displayId: id };
      },
      input: (displayId, cmd) => bridge.input(displayId, cmd),
      writeClipboard: (text) => bridge.clipboardWrite(text),
      watchClipboard(cb) {
        let last: string | null = null;
        let stopped = false;
        const tick = async () => {
          if (stopped) return;
          const text = await bridge.clipboardRead().catch(() => '');
          if (last !== null && text !== last) cb(text);
          last = text;
        };
        void tick();
        const timer = setInterval(tick, 800);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      },
      fileSink: diskSink,
    },
    viewerFileSink: diskSink,
    clipboard: {
      read: () => bridge.clipboardRead(),
      write: (text) => bridge.clipboardWrite(text),
    },
    notify: (title, body) => bridge.notify(title, body),
    attention: () => bridge.attention(),
    openExternal: (url) => bridge.openExternal(url),
    desktop: {
      version: bridge.version,
      setLaunchAtLogin: (v) => bridge.setLaunchAtLogin(v),
      setTrayStatus: (s) => bridge.setTrayStatus(s),
      setSessionBar: (s) => bridge.setSessionBar(s),
      onSessionBarAction: (cb) => bridge.onSessionBarAction(cb),
      lockScreen: () => bridge.lockScreen(),
      permissions: () => bridge.permissions(),
      openPermissionSettings: (k) => bridge.openPermissionSettings(k),
      onDeepLink: (cb) => bridge.onDeepLink(cb),
      revealFile: (p) => bridge.revealFile(p),
      downloadsDir: () => bridge.downloadsDir(),
      chooseDownloadsDir: () => bridge.chooseDownloadsDir(),
      inputAvailable: () => inputOk,
      secureStorage: bridge.secureStorage !== false,
      quit: () => bridge.quit(),
    },
  };
}
