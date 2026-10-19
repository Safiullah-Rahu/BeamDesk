/**
 * Contract between the desktop app's preload script (Electron) and the shared UI.
 * Exposed as `window.beamdesk` with contextIsolation; only these functions cross the boundary.
 */
import type { InputCommand } from './host.ts';

export interface DesktopDisplay {
  id: string;
  /** desktopCapturer source id ("screen:1:0"). */
  sourceId: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
}

export interface DesktopPermissionState {
  screen: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';
  accessibility: boolean;
  wayland: boolean;
}

export interface DesktopTrayStatus {
  id: string;
  sessions: number;
  online: boolean;
}

export interface DesktopSessionBarState {
  sessions: { sid: string; name: string; viewerId: string; control: boolean }[];
}

export type SessionBarAction = { type: 'end' | 'end-all' | 'show'; sid?: string };

export interface DesktopBridge {
  version: string;
  os: 'windows' | 'macos' | 'linux';
  defaultServer: string;
  wayland: boolean;
  store: {
    load(): { data: Record<string, unknown>; secrets: Record<string, string> };
    set(key: string, value: unknown): void;
    setSecret(key: string, value: string | null): void;
  };
  displays(): Promise<DesktopDisplay[]>;
  input(displayId: string, cmd: InputCommand): void;
  inputAvailable(): boolean;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  fileOpen(name: string, size: number): Promise<number | null>;
  fileWrite(handle: number, chunk: Uint8Array): Promise<void>;
  fileClose(handle: number): Promise<string>;
  fileAbort(handle: number): void;
  revealFile(path: string): void;
  downloadsDir(): string;
  chooseDownloadsDir(): Promise<string | null>;
  setLaunchAtLogin(enabled: boolean): void;
  setTrayStatus(status: DesktopTrayStatus): void;
  setSessionBar(state: DesktopSessionBarState): void;
  onSessionBarAction(cb: (a: SessionBarAction) => void): () => void;
  onSessionBarState(cb: (s: DesktopSessionBarState) => void): () => void;
  sessionBarAction(a: SessionBarAction): void;
  onDeepLink(cb: (url: string) => void): () => void;
  lockScreen(): void;
  permissions(): Promise<DesktopPermissionState>;
  openPermissionSettings(kind: 'screen' | 'accessibility'): void;
  attention(): void;
  notify(title: string, body: string): void;
  openExternal(url: string): void;
  quit(): void;
}
