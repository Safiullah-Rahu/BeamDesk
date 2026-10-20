/**
 * Settings persistence for the desktop app.
 * Regular settings live in settings.json; secrets (device key, permanent password secret,
 * saved passwords) are encrypted with the operating system's keychain via safeStorage.
 */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

interface FileShape {
  data: Record<string, unknown>;
  /** key -> base64 ciphertext (or "plain:" + value when no keychain is available). */
  secrets: Record<string, string>;
}

/** True when secrets get real OS keychain protection (Linux may fall back to a hard-coded key). */
export function secureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  try {
    return safeStorage.getSelectedStorageBackend() !== 'basic_text';
  } catch {
    return false;
  }
}

export class SettingsStore {
  private file = path.join(app.getPath('userData'), 'settings.json');
  private state: FileShape = { data: {}, secrets: {} };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') this.state = { data: raw.data ?? {}, secrets: raw.secrets ?? {} };
    } catch {
      /* first run */
    }
  }

  /** Everything, for the UI. Keys in `hidden` stay in the main process (e.g. the server's private key). */
  load(hidden: ReadonlySet<string> = new Set()): { data: Record<string, unknown>; secrets: Record<string, string> } {
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.state.secrets)) {
      if (hidden.has(k)) continue;
      const plain = this.decrypt(v);
      if (plain !== null) secrets[k] = plain;
    }
    return { data: this.state.data, secrets };
  }

  getSecret(key: string): string | null {
    const v = this.state.secrets[key];
    return v === undefined ? null : this.decrypt(v);
  }

  get<T>(key: string): T | undefined {
    return this.state.data[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    if (typeof key !== 'string' || key.length > 64) return;
    this.state.data[key] = value;
    this.schedule();
  }

  setSecret(key: string, value: string | null): void {
    if (typeof key !== 'string' || key.length > 64) return;
    if (value === null) delete this.state.secrets[key];
    else if (typeof value === 'string') this.state.secrets[key] = this.encrypt(value);
    this.schedule();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] could not save settings', err);
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  private encrypt(value: string): string {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(value).toString('base64');
    return `plain:${value}`;
  }

  private decrypt(value: string): string | null {
    if (value.startsWith('plain:')) return value.slice(6);
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    } catch {
      return null;
    }
  }
}
