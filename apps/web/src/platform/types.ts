import type { FileSinkFactory, HostPlatform, Platform } from '@beamdesk/core';

export interface KeyValueStore {
  /** Everything persisted so far (synchronous, loaded once at startup). */
  data: Record<string, unknown>;
  secrets: Record<string, string>;
  set(key: string, value: unknown): void;
  /** Secrets are encrypted with the OS keychain on desktop. */
  setSecret(key: string, value: string | null): void;
}

export interface DesktopPermissions {
  screen: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';
  accessibility: boolean;
  wayland: boolean;
}

export interface SessionBarState {
  sessions: { sid: string; name: string; viewerId: string; control: boolean }[];
}

/** Extra capabilities only the desktop app has. */
export interface DesktopExtras {
  version: string;
  setLaunchAtLogin(enabled: boolean): void;
  setTrayStatus(status: { id: string; sessions: number; online: boolean }): void;
  setSessionBar(state: SessionBarState): void;
  onSessionBarAction(cb: (action: { type: 'end' | 'end-all' | 'show'; sid?: string }) => void): () => void;
  lockScreen(): void;
  permissions(): Promise<DesktopPermissions>;
  openPermissionSettings(kind: 'screen' | 'accessibility'): void;
  onDeepLink(cb: (url: string) => void): () => void;
  revealFile(path: string): void;
  downloadsDir(): string;
  chooseDownloadsDir(): Promise<string | null>;
  inputAvailable(): boolean;
  /** False when secrets are stored without OS keychain protection. */
  secureStorage: boolean;
  quit(): void;
}

export interface AppPlatform {
  kind: 'desktop' | 'web';
  os: Platform;
  /** Server address used when the user has not configured one. */
  defaultServer: string;
  store: KeyValueStore;
  host: HostPlatform & {
    /**
     * Browsers only open the screen picker from a click: pick once while sharing is turned on,
     * then every session gets a clone. `onEnded` fires if the user stops sharing in the browser UI.
     */
    prepareCapture?(onEnded?: () => void): Promise<void>;
    hasPreparedCapture?(): boolean;
    releasePreparedCapture?(): void;
  };
  /** Where files received while viewing a remote device are saved. */
  viewerFileSink: FileSinkFactory;
  clipboard: {
    read(): Promise<string>;
    write(text: string): Promise<void>;
  };
  notify(title: string, body: string): void;
  /** Bring the app to the foreground (incoming requests). */
  attention(): void;
  openExternal(url: string): void;
  desktop?: DesktopExtras;
}
