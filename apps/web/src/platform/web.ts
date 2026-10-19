/** Browser implementation: share-only hosting (no remote control) and full viewing. */
import type { FileSink, FileSinkFactory, Platform } from '@beamdesk/core';
import type { AppPlatform, KeyValueStore } from './types.ts';

declare const __DEFAULT_SERVER__: string;

const DATA_KEY = 'beamdesk:data';
const SECRETS_KEY = 'beamdesk:secrets';

function readJson(key: string): Record<string, any> {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function localStore(): KeyValueStore {
  const data = readJson(DATA_KEY);
  const secrets = readJson(SECRETS_KEY) as Record<string, string>;
  const persist = (key: string, obj: unknown) => {
    try {
      localStorage.setItem(key, JSON.stringify(obj));
    } catch (err) {
      console.warn('[beamdesk] could not save settings', err);
    }
  };
  return {
    data,
    secrets,
    set(key, value) {
      data[key] = value;
      persist(DATA_KEY, data);
    },
    setSecret(key, value) {
      if (value === null) delete secrets[key];
      else secrets[key] = value;
      persist(SECRETS_KEY, secrets);
    },
  };
}

export function detectOs(): Platform {
  const ua = navigator.userAgent;
  const uaPlatform = ((navigator as any).userAgentData?.platform || navigator.platform || '').toLowerCase();
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || (uaPlatform.includes('mac') && navigator.maxTouchPoints > 1)) return 'ios';
  if (uaPlatform.includes('mac')) return 'macos';
  if (uaPlatform.includes('win')) return 'windows';
  if (uaPlatform.includes('linux') || uaPlatform.includes('cros')) return 'linux';
  return 'web';
}

/** Collects a received file in memory and hands it to the browser as a download. */
export const blobDownloadSink: FileSinkFactory = (meta) => {
  const parts: Uint8Array[] = [];
  const sink: FileSink = {
    write: (chunk) => void parts.push(chunk.slice()),
    close: () => {
      const blob = new Blob(parts as BlobPart[], { type: meta.mime || 'application/octet-stream' });
      parts.length = 0;
      downloadBlob(blob, meta.name);
      return `Downloads/${meta.name}`;
    },
    abort: () => void (parts.length = 0),
  };
  return sink;
};

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function createWebPlatform(): AppPlatform {
  let prepared: MediaStream | null = null;
  const live = (s: MediaStream | null) => !!s && s.getVideoTracks().some((t) => t.readyState === 'live');

  const pick = async (fps: number) =>
    navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: Math.min(fps, 60), max: 60 }, displaySurface: 'monitor' },
      audio: true,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'include',
      monitorTypeSurfaces: 'include',
    } as DisplayMediaStreamOptions);

  return {
    kind: 'web',
    os: detectOs(),
    // A build can point at a remote server (e.g. the app hosted on a CDN); otherwise use this origin.
    defaultServer: __DEFAULT_SERVER__ || (location.protocol.startsWith('http') ? location.origin : ''),
    store: localStore(),
    host: {
      kind: 'web',
      capabilities: () => ({ control: false, audio: true, files: true, clipboard: false, multiDisplay: false }),
      async listDisplays() {
        const dpr = window.devicePixelRatio || 1;
        return [{ id: 'screen', name: 'Shared screen', width: Math.round(screen.width * dpr), height: Math.round(screen.height * dpr), primary: true }];
      },
      async prepareCapture(onEnded) {
        if (live(prepared)) return;
        const stream = await pick(30);
        prepared = stream;
        stream.getVideoTracks()[0]?.addEventListener('ended', () => {
          if (prepared === stream) prepared = null;
          onEnded?.();
        });
      },
      hasPreparedCapture: () => live(prepared),
      releasePreparedCapture() {
        prepared?.getTracks().forEach((t) => t.stop());
        prepared = null;
      },
      async capture(_displayId, opts) {
        // Sessions get clones so ending one session keeps the shared screen ready for the next.
        const stream = live(prepared) ? prepared!.clone() : await pick(opts.fps);
        if (!opts.audio) {
          for (const t of stream.getAudioTracks()) {
            t.stop();
            stream.removeTrack(t);
          }
        }
        return { stream, displayId: 'screen' };
      },
      fileSink: blobDownloadSink,
    },
    viewerFileSink: blobDownloadSink,
    clipboard: {
      async read() {
        try {
          return await navigator.clipboard.readText();
        } catch {
          return '';
        }
      },
      async write(text) {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          /* needs focus/permission; ignore */
        }
      },
    },
    notify(title, body) {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.hasFocus()) return;
      try {
        const n = new Notification(title, { body, icon: './icon.svg' });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        /* unsupported (e.g. Android Chrome without service worker) */
      }
    },
    attention() {
      window.focus();
    },
    openExternal(url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  };
}
