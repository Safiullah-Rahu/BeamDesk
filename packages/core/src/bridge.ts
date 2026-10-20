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

/** Host mode settings (this computer runs the BeamDesk server). */
export interface HostModeConfig {
  enabled: boolean;
  /** Ask the router to open the port (UPnP / NAT-PMP). */
  portMapping: boolean;
  /** Keep the computer from sleeping while hosting. */
  keepAwake: boolean;
  /** TCP and UDP port. */
  port: number;
  /** Optional DNS name (dynamic DNS) or fixed address that reaches this computer. */
  publicHost: string;
}

export interface HostModeStatus {
  state: 'running' | 'stopped';
  port: number;
  fingerprint: string;
  lan: string | null;
  tailscale: string | null;
  internet: {
    mapping: 'off' | 'pending' | 'upnp' | 'nat-pmp' | 'failed';
    mappingError: string | null;
    externalIp: string | null;
    externalPort: number;
    behindCgnat: boolean;
    reachable: 'checking' | 'yes' | 'unknown';
  };
  publicHost: string | null;
  /** The connection code to give to other devices. */
  code: string;
  browserUrls: string[];
  devices: number;
}

export interface HostModeInfo {
  config: HostModeConfig;
  phase: 'off' | 'starting' | 'running' | 'error';
  error: string | null;
  /** This device's own connection while hosting. */
  localUrl: string | null;
  accessKey: string | null;
  status: HostModeStatus | null;
}

export interface DesktopBridge {
  version: string;
  os: 'windows' | 'macos' | 'linux';
  defaultServer: string;
  wayland: boolean;
  /** Secrets are protected by the OS keychain (false: stored in plain text, e.g. no keyring on Linux). */
  secureStorage: boolean;
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
  hostMode: {
    get(): HostModeInfo;
    set(patch: Partial<HostModeConfig>): Promise<HostModeInfo>;
    /** New access key and certificate: every device has to join again. */
    regenerate(): Promise<HostModeInfo>;
    refresh(): void;
    onChange(cb: (info: HostModeInfo) => void): () => void;
  };
  /** WebSockets to home servers, with the certificate pinned by the main process. */
  pinnedSocket: {
    open(url: string): Promise<number | null>;
    send(id: number, data: string): void;
    close(id: number, code?: number, reason?: string): void;
    onEvent(cb: (e: PinnedSocketEvent) => void): () => void;
  };
}

export type PinnedSocketEvent =
  | { id: number; type: 'open' }
  | { id: number; type: 'message'; data: string }
  | { id: number; type: 'close'; code: number; reason: string };
