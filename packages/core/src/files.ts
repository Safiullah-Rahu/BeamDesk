/**
 * File transfer over a reliable, ordered WebRTC data channel.
 *
 * Text frames carry JSON control messages, binary frames carry data:
 *   [transfer id: u32][payload]
 * The sender respects `bufferedAmount` so huge files never balloon memory, and the
 * receiver streams chunks into a sink (disk on desktop, a Blob download in browsers).
 */
import { Emitter, randomBytes } from './util.ts';
import { LIMITS } from './protocol.ts';

export interface FileMeta {
  id: number;
  name: string;
  size: number;
  mime: string;
}

export interface FileSink {
  write(chunk: Uint8Array): void | Promise<void>;
  /** Returns a human readable location ("Downloads/BeamDesk/report.pdf") if any. */
  close(): Promise<string | void> | string | void;
  abort(): void;
}

/** Returns null to refuse the file (e.g. no permission). */
export type FileSinkFactory = (meta: FileMeta) => Promise<FileSink | null> | FileSink | null;

/** Asks the local user whether to save an incoming file. Resolves false to refuse it. */
export type FileConsent = (meta: FileMeta) => Promise<boolean>;

export type TransferState = 'queued' | 'active' | 'done' | 'failed' | 'cancelled';

export interface Transfer {
  id: number;
  direction: 'send' | 'receive';
  name: string;
  size: number;
  transferred: number;
  state: TransferState;
  startedAt: number;
  /** Bytes per second, smoothed. */
  rate: number;
  location?: string;
  error?: string;
}

type Msg =
  | { t: 'start'; id: number; name: string; size: number; mime: string }
  | { t: 'end'; id: number }
  | { t: 'accept'; id: number }
  | { t: 'ack'; id: number }
  | { t: 'cancel'; id: number; reason?: string }
  | { t: 'reject'; id: number; reason?: string };

const HIGH_WATER = 8 * 1024 * 1024;
/** Received bytes not yet written to the sink before a transfer is aborted. */
const MAX_UNWRITTEN = 64 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;
const MAX_NAME = 255;
/** Incoming files in flight at once; more are refused so a peer cannot pile up open files. */
const MAX_INCOMING = 4;
/** Finished transfers kept in the list. */
const MAX_RECORDS = 200;

/** Extensions that can run code when opened. Receiving one deserves an explicit warning. */
const RISKY = new Set(
  (
    'exe com scr pif bat cmd ps1 psm1 vbs vbe js jse wsf wsh hta msi msp msc lnk url reg cpl dll jar ' +
    'app pkg dmg command tool sh bash zsh run bin appimage deb rpm py pl rb iso img vhd vhdx scpt workflow terminal'
  ).split(' '),
);

/** True for executables, scripts, installers and shortcuts. */
export function isRiskyFileName(name: string): boolean {
  const lower = name.toLowerCase().replace(/[\s.]+$/, '');
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  return RISKY.has(ext);
}

/** Strips paths and characters that are invalid on Windows/macOS/Linux. */
export function sanitizeFileName(name: string): string {
  let n = String(name || '').split(/[\\/]/).pop() || '';
  n = n
    .replace(/[\u0000-\u001f\u007f<>:"|?*\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '_')
    // Runs of spaces can push a real extension out of sight ("invoice.pdf          .exe").
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`;
  if (!n) n = 'file';
  if (n.length > MAX_NAME) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : '';
    n = n.slice(0, MAX_NAME - ext.length) + ext;
  }
  return n;
}

export class FileTransfers extends Emitter<{ update: Transfer[]; received: Transfer }> {
  private channel: RTCDataChannel | null = null;
  private transfers = new Map<number, Transfer>();
  private outgoing: { transfer: Transfer; file: Blob }[] = [];
  private sending = false;
  private incoming = new Map<number, { transfer: Transfer; sink: FileSink | null; chain: Promise<void>; pending: number }>();
  /** Outgoing files waiting for the receiver to accept them. */
  private awaiting = new Map<number, (accepted: boolean) => void>();
  private cancelled = new Set<number>();
  private updateTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly sinkFactory: FileSinkFactory;
  private readonly allowReceive: () => boolean;
  private readonly consent: FileConsent | null;

  constructor(sinkFactory: FileSinkFactory, allowReceive: () => boolean, consent: FileConsent | null = null) {
    super();
    this.sinkFactory = sinkFactory;
    this.allowReceive = allowReceive;
    this.consent = consent;
  }

  attach(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.addEventListener('message', (e) => this.onMessage(e.data));
    channel.addEventListener('open', () => this.pump());
    channel.addEventListener('close', () => this.failAll('Connection closed'));
  }

  list(): Transfer[] {
    return [...this.transfers.values()];
  }

  send(files: Iterable<File | (Blob & { name?: string })>): void {
    for (const file of files) {
      const id = new DataView(randomBytes(4).buffer).getUint32(0);
      const transfer: Transfer = {
        id,
        direction: 'send',
        name: sanitizeFileName((file as File).name ?? 'file'),
        size: file.size,
        transferred: 0,
        state: 'queued',
        startedAt: 0,
        rate: 0,
      };
      this.transfers.set(id, transfer);
      this.outgoing.push({ transfer, file });
    }
    this.changed(true);
    void this.pump();
  }

  cancel(id: number): void {
    const t = this.transfers.get(id);
    if (!t || t.state === 'done' || t.state === 'failed' || t.state === 'cancelled') return;
    t.state = 'cancelled';
    this.cancelled.add(id);
    this.outgoing = this.outgoing.filter((o) => o.transfer.id !== id);
    this.awaiting.get(id)?.(false);
    const inc = this.incoming.get(id);
    if (inc) {
      inc.sink?.abort();
      this.incoming.delete(id);
    }
    this.sendJson({ t: 'cancel', id });
    this.changed(true);
  }

  /** Cancels everything in flight (e.g. when file permission is revoked). */
  cancelAll(): void {
    for (const t of this.list()) if (t.state === 'active' || t.state === 'queued') this.cancel(t.id);
  }

  clearFinished(): void {
    for (const [id, t] of this.transfers) if (t.state !== 'active' && t.state !== 'queued') this.transfers.delete(id);
    this.changed(true);
  }

  dispose(): void {
    this.failAll('Session ended');
    this.removeAllListeners();
  }

  private sendJson(m: Msg): void {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(m));
  }

  private async waitForDrain(): Promise<void> {
    const ch = this.channel!;
    if (ch.bufferedAmount <= HIGH_WATER) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        ch.removeEventListener('bufferedamountlow', done);
        ch.removeEventListener('close', done);
        resolve();
      };
      ch.addEventListener('bufferedamountlow', done);
      ch.addEventListener('close', done);
    });
  }

  private async pump(): Promise<void> {
    if (this.sending || !this.channel || this.channel.readyState !== 'open') return;
    this.sending = true;
    try {
      while (this.outgoing.length && this.channel.readyState === 'open') {
        const { transfer, file } = this.outgoing.shift()!;
        await this.sendOne(transfer, file);
      }
    } finally {
      this.sending = false;
    }
  }

  private async sendOne(t: Transfer, file: Blob): Promise<void> {
    const ch = this.channel!;
    // Nothing is streamed until the receiver (or its user) has accepted the file.
    const accepted = new Promise<boolean>((resolve) => this.awaiting.set(t.id, resolve));
    this.sendJson({ t: 'start', id: t.id, name: t.name, size: t.size, mime: file.type || 'application/octet-stream' });
    const ok = await accepted;
    this.awaiting.delete(t.id);
    if (!ok || this.cancelled.has(t.id) || t.state !== 'queued') return;
    t.state = 'active';
    t.startedAt = Date.now();
    this.changed(true);
    const chunk = LIMITS.fileChunkBytes - 4;
    let offset = 0;
    let lastTick = Date.now();
    let lastBytes = 0;
    try {
      while (offset < file.size) {
        if (this.cancelled.has(t.id)) return;
        if (ch.readyState !== 'open') throw new Error('Connection closed');
        await this.waitForDrain();
        const buf = new Uint8Array(await file.slice(offset, offset + chunk).arrayBuffer());
        const frame = new Uint8Array(buf.length + 4);
        new DataView(frame.buffer).setUint32(0, t.id);
        frame.set(buf, 4);
        ch.send(frame);
        offset += buf.length;
        t.transferred = offset;
        const now = Date.now();
        if (now - lastTick >= 500) {
          t.rate = smooth(t.rate, ((offset - lastBytes) * 1000) / (now - lastTick));
          lastTick = now;
          lastBytes = offset;
          this.changed();
        }
      }
      if (this.cancelled.has(t.id)) return;
      // Stays "active" until the receiver acknowledges it saved the file.
      this.sendJson({ t: 'end', id: t.id });
    } catch (err) {
      t.state = 'failed';
      t.error = (err as Error).message;
    }
    this.changed(true);
  }

  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      let m: Msg;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (!m || typeof m.id !== 'number') return;
      if (m.t === 'start') void this.onStart(m);
      else if (m.t === 'accept') this.awaiting.get(m.id)?.(true);
      else if (m.t === 'end') this.onEnd(m.id);
      else if (m.t === 'ack') this.onAck(m.id);
      else if (m.t === 'reject') this.onRemoteCancel(m.id, 'failed', m.reason ?? 'Refused by the other side');
      else if (m.t === 'cancel') this.onRemoteCancel(m.id, 'cancelled', m.reason ?? 'Cancelled by the other side');
      return;
    }
    if (!(data instanceof ArrayBuffer) || data.byteLength < 4) return;
    const id = new DataView(data).getUint32(0);
    const inc = this.incoming.get(id);
    if (!inc) return;
    if (!inc.sink) {
      // Data before we accepted the file: the sender is not following the protocol.
      this.failIncoming(id, 'The file was sent before it was accepted');
      return;
    }
    const chunk = new Uint8Array(data, 4);
    inc.transfer.transferred += chunk.length;
    if (inc.transfer.transferred > inc.transfer.size) {
      this.failIncoming(id, 'Received more data than announced');
      return;
    }
    // A sender that ignores back-pressure must not make us buffer unbounded data in memory.
    inc.pending += chunk.length;
    if (inc.pending > MAX_UNWRITTEN) {
      this.failIncoming(id, 'The file arrived faster than it could be saved');
      return;
    }
    const sink = inc.sink;
    inc.chain = inc.chain
      .then(() => sink.write(chunk))
      .then(() => void (inc.pending -= chunk.length))
      .catch((err) => this.failIncoming(id, (err as Error).message));
    const now = Date.now();
    const t = inc.transfer;
    const elapsed = (now - t.startedAt) / 1000;
    if (elapsed > 0) t.rate = t.transferred / elapsed;
    this.changed();
  }

  private async onStart(m: Extract<Msg, { t: 'start' }>): Promise<void> {
    if (this.incoming.has(m.id) || this.transfers.has(m.id)) return;
    // Refusals are not recorded: a peer must not be able to flood the transfer list.
    if (!this.allowReceive()) return this.sendJson({ t: 'reject', id: m.id, reason: 'File transfer is not allowed' });
    if (this.incoming.size >= MAX_INCOMING) return this.sendJson({ t: 'reject', id: m.id, reason: 'Too many files at once. Try again in a moment.' });
    this.trim();
    const transfer: Transfer = {
      id: m.id,
      direction: 'receive',
      name: sanitizeFileName(m.name),
      size: Math.max(0, Math.floor(Number(m.size)) || 0),
      transferred: 0,
      state: 'queued',
      startedAt: Date.now(),
      rate: 0,
    };
    const meta: FileMeta = { id: m.id, name: transfer.name, size: transfer.size, mime: String(m.mime || '').slice(0, 128) };
    const entry = { transfer, sink: null as FileSink | null, chain: Promise.resolve(), pending: 0 };
    this.incoming.set(m.id, entry);
    this.transfers.set(m.id, transfer);
    this.changed(true);
    let allowed = true;
    if (this.consent) {
      try {
        allowed = await this.consent(meta);
      } catch {
        allowed = false;
      }
    }
    let sink: FileSink | null = null;
    if (allowed && this.incoming.get(m.id) === entry && this.allowReceive()) {
      try {
        sink = await this.sinkFactory(meta);
      } catch {
        sink = null;
      }
    }
    if (this.incoming.get(m.id) !== entry) {
      // Cancelled (or the session ended) while we were asking or opening the file: release it.
      sink?.abort();
      return;
    }
    if (!sink) {
      this.incoming.delete(m.id);
      transfer.state = allowed ? 'failed' : 'cancelled';
      transfer.error = !allowed ? 'Declined' : this.allowReceive() ? 'Could not save the file' : 'File transfer is not allowed';
      this.sendJson({ t: 'reject', id: m.id, reason: allowed ? transfer.error : 'Declined by the other side' });
      this.changed(true);
      return;
    }
    entry.sink = sink;
    transfer.state = 'active';
    transfer.startedAt = Date.now();
    this.sendJson({ t: 'accept', id: m.id });
    this.changed(true);
  }

  /** Forgets the oldest finished transfers once the list gets long. */
  private trim(): void {
    if (this.transfers.size < MAX_RECORDS) return;
    for (const [id, t] of this.transfers) {
      if (this.transfers.size < MAX_RECORDS) break;
      if (t.state !== 'active' && t.state !== 'queued') {
        this.transfers.delete(id);
        this.cancelled.delete(id);
      }
    }
  }

  private onEnd(id: number): void {
    const inc = this.incoming.get(id);
    if (!inc) return;
    this.incoming.delete(id);
    inc.chain = inc.chain.then(async () => {
      if (inc.transfer.state !== 'active') return;
      if (inc.transfer.transferred !== inc.transfer.size) throw new Error('Transfer incomplete');
      const location = await inc.sink?.close();
      inc.transfer.state = 'done';
      if (typeof location === 'string') inc.transfer.location = location;
      this.sendJson({ t: 'ack', id });
      this.changed(true);
      this.emit('received', inc.transfer);
    }).catch((err) => {
      inc.sink?.abort();
      inc.transfer.state = 'failed';
      inc.transfer.error = (err as Error).message;
      this.changed(true);
    });
  }

  private onAck(id: number): void {
    const t = this.transfers.get(id);
    if (!t || t.direction !== 'send' || t.state !== 'active') return;
    t.state = 'done';
    this.changed(true);
  }

  private onRemoteCancel(id: number, state: 'failed' | 'cancelled', reason: string): void {
    const t = this.transfers.get(id);
    if (!t || t.state === 'done') return;
    this.cancelled.add(id);
    this.outgoing = this.outgoing.filter((o) => o.transfer.id !== id);
    this.awaiting.get(id)?.(false);
    const inc = this.incoming.get(id);
    if (inc) {
      inc.sink?.abort();
      this.incoming.delete(id);
    }
    t.state = state;
    t.error = reason;
    this.changed(true);
  }

  private failIncoming(id: number, reason: string): void {
    const inc = this.incoming.get(id);
    if (!inc) return;
    this.incoming.delete(id);
    inc.sink?.abort();
    inc.transfer.state = 'failed';
    inc.transfer.error = reason;
    this.sendJson({ t: 'cancel', id, reason });
    this.changed(true);
  }

  private failAll(reason: string): void {
    for (const t of this.transfers.values()) {
      if (t.state === 'active' || t.state === 'queued') {
        t.state = 'failed';
        t.error = reason;
      }
    }
    for (const inc of this.incoming.values()) inc.sink?.abort();
    this.incoming.clear();
    for (const resolve of this.awaiting.values()) resolve(false);
    this.awaiting.clear();
    this.outgoing = [];
    this.changed(true);
  }

  /** Coalesces progress updates to at most ~5 per second. */
  private changed(immediate = false): void {
    if (immediate) {
      if (this.updateTimer) clearTimeout(this.updateTimer);
      this.updateTimer = null;
      this.emit('update', this.list());
      return;
    }
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.emit('update', this.list());
    }, 200);
  }
}

const smooth = (prev: number, next: number) => (prev ? prev * 0.6 + next * 0.4 : next);
