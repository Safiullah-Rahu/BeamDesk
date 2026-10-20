import type { CodecPreference, KeyboardMode, Permissions, Platform, QualitySettings } from '@beamdesk/core';

export type ScaleMode = 'fit' | 'original' | 'stretch';
export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  deviceName: string;
  theme: Theme;
  serverUrl: string;
  accessKey: string;
  /** Desktop: use the server address above, or the home server joined with a connection code. */
  connection: 'server' | 'home';

  // Incoming connections (this device as host)
  access: 'ask' | 'password' | 'off';
  oneTimePassword: boolean;
  otpLength: number;
  otpRotate: 'session' | 'manual';
  askEvenWithPassword: boolean;
  unattended: boolean;
  trustedAutoAccept: boolean;
  maxSessions: number;
  defaultPerms: Permissions;
  lockOnEnd: boolean;
  shareAudio: boolean;
  forceRelay: boolean;

  // Outgoing connections (this device as viewer)
  quality: QualitySettings;
  codec: CodecPreference;
  keyboardMode: KeyboardMode;
  swapCmdCtrl: boolean;
  syncClipboard: boolean;
  scaleMode: ScaleMode;
  showStats: boolean;
  remoteAudio: boolean;

  // App
  launchAtLogin: boolean;
  minimizeToTray: boolean;
  sounds: boolean;
  notifications: boolean;
}

export interface Contact {
  id: string;
  name: string;
  /** Pinned host public key (trust on first use). */
  pk?: string;
  platform?: Platform;
  favorite: boolean;
  lastConnected: number;
}

export interface TrustedDevice {
  id: string;
  pk: string;
  name: string;
  added: number;
}

export interface BlockedDevice {
  id: string;
  name: string;
  added: number;
}

function defaultName(os: Platform): string {
  const labels: Partial<Record<Platform, string>> = {
    windows: 'Windows PC',
    macos: 'Mac',
    linux: 'Linux PC',
    android: 'Android phone',
    ios: 'iPhone / iPad',
  };
  return labels[os] ?? 'Web browser';
}

export function defaultSettings(os: Platform, kind: 'desktop' | 'web'): Settings {
  return {
    deviceName: kind === 'web' ? `${defaultName(os)} (browser)` : defaultName(os),
    theme: 'system',
    serverUrl: '',
    accessKey: '',
    connection: 'server',
    access: 'ask',
    oneTimePassword: true,
    otpLength: 6,
    otpRotate: 'session',
    askEvenWithPassword: false,
    unattended: false,
    trustedAutoAccept: true,
    maxSessions: 3,
    defaultPerms: { control: true, clipboard: true, files: true, audio: false },
    lockOnEnd: false,
    shareAudio: false,
    forceRelay: false,
    quality: { preset: 'balanced' },
    codec: 'auto',
    keyboardMode: 'translate',
    swapCmdCtrl: true,
    syncClipboard: true,
    scaleMode: 'fit',
    showStats: false,
    remoteAudio: true,
    launchAtLogin: kind === 'desktop',
    minimizeToTray: true,
    sounds: true,
    notifications: true,
  };
}

/** Merges stored values over defaults, ignoring unknown or wrongly typed keys. */
export function mergeSettings(defaults: Settings, stored: unknown): Settings {
  if (!stored || typeof stored !== 'object') return defaults;
  const out: any = { ...defaults };
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (!(k in defaults)) continue;
    const d = (defaults as any)[k];
    if (typeof d === typeof v && (typeof d !== 'object' || (d && v && !Array.isArray(v)))) {
      out[k] = typeof d === 'object' ? { ...d, ...(v as object) } : v;
    }
  }
  return out as Settings;
}
