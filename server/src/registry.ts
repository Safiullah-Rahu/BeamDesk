/**
 * Remembers which public key owns which device ID (trust on first use), so nobody can
 * take over an ID that is already in use. Persisted as a small JSON file.
 */
import fs from 'node:fs';
import path from 'node:path';

interface Entry {
  pk: string;
  seen: number;
}

const RETENTION_MS = 365 * 24 * 3600 * 1000;

export class DeviceRegistry {
  private entries = new Map<string, Entry>();
  private file: string | null;
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string | null) {
    this.file = dataDir ? path.join(dataDir, 'devices.json') : null;
    this.load();
    if (this.file) {
      this.timer = setInterval(() => this.flush(), 15_000);
      this.timer.unref();
    }
  }

  /** Returns false when the ID is already bound to a different key. */
  claim(id: string, pk: string): boolean {
    const now = Date.now();
    const existing = this.entries.get(id);
    if (existing && existing.pk !== pk && now - existing.seen < RETENTION_MS) return false;
    const changed = !existing || existing.pk !== pk || now - existing.seen > 3600_000;
    this.entries.set(id, { pk, seen: now });
    if (changed) this.dirty = true;
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  flush(): void {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    const now = Date.now();
    const obj: Record<string, Entry> = {};
    for (const [id, e] of this.entries) if (now - e.seen < RETENTION_MS) obj[id] = e;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.dirty = true;
      console.error('[registry] could not save devices.json:', (err as Error).message);
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.flush();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, Entry>;
      for (const [id, e] of Object.entries(raw)) {
        if (/^\d{9}$/.test(id) && typeof e?.pk === 'string' && typeof e.seen === 'number') this.entries.set(id, e);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[registry] could not read devices.json:', (err as Error).message);
    }
  }
}
