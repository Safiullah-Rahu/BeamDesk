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
  | { t: 'ack'; id: number }
  | { t: 'cancel'; id: number; reason?: string }
  | { t: 'reject'; id: number; reason?: string };

const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;
const MAX_NAME = 255;

/** Strips paths and characters that are invalid on Windows/macOS/Linux. */
export function sanitizeFileName(name: string): string {
  let n = String(name || '').split(/[\\/]/).pop() || '';
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*‪-‮⁦-⁩]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
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
  private incoming = new Map<number, { transfer: Transfer; sink: FileSink | null; chain: Promise<void> }>();
  private cancelled = new Set<number>();
  private updateTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly sinkFactory: FileSinkFactory;
  private readonly allowReceive: () => boolean;

  constructor(sinkFactory: FileSinkFactory, allowReceive: () => boolean) {
    super();
    this.sinkFactory = sinkFactory;
    this.allowReceive = allowReceive;
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
    const inc = this.incoming.get(id);
    if (inc) {
      inc.sink?.abort();
      this.incoming.delete(id);
    }
    this.sendJson({ t: 'cancel', id });
    this.changed(true);
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
    t.state = 'active';
    t.startedAt = Date.now();
    this.changed(true);
    this.sendJson({ t: 'start', id: t.id, name: t.name, size: t.size, mime: file.type || 'application/octet-stream' });
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
    const chunk = new Uint8Array(data, 4);
    inc.transfer.transferred += chunk.length;
    if (inc.transfer.transferred > inc.transfer.size) {
      this.failIncoming(id, 'Received more data than announced');
      return;
    }
    // Evaluate the sink lazily: the first chunks can arrive before the sink is open.
    inc.chain = inc.chain.then(() => inc.sink?.write(chunk)).catch((err) => this.failIncoming(id, (err as Error).message));
    const now = Date.now();
    const t = inc.transfer;
    const elapsed = (now - t.startedAt) / 1000;
    if (elapsed > 0) t.rate = t.transferred / elapsed;
    this.changed();
  }

  private async onStart(m: Extract<Msg, { t: 'start' }>): Promise<void> {
    if (this.incoming.has(m.id) || this.transfers.has(m.id)) return;
    const transfer: Transfer = {
      id: m.id,
      direction: 'receive',
      name: sanitizeFileName(m.name),
      size: Math.max(0, Number(m.size) || 0),
      transferred: 0,
      state: 'active',
      startedAt: Date.now(),
      rate: 0,
    };
    // Register synchronously so that chunks arriving while the sink opens are queued.
    let resolveSink!: (s: FileSink | null) => void;
    const sinkReady = new Promise<FileSink | null>((r) => (resolveSink = r));
    const entry = { transfer, sink: null as FileSink | null, chain: sinkReady.then(() => undefined) };
    this.incoming.set(m.id, entry);
    this.transfers.set(m.id, transfer);
    this.changed(true);
    let sink: FileSink | null = null;
    try {
      sink = this.allowReceive() ? await this.sinkFactory({ id: m.id, name: transfer.name, size: transfer.size, mime: String(m.mime || '') }) : null;
    } catch {
      sink = null;
    }
    entry.sink = sink;
    resolveSink(sink);
    if (!sink) {
      this.incoming.delete(m.id);
      transfer.state = 'failed';
      transfer.error = this.allowReceive() ? 'Could not save the file' : 'File transfer is not allowed';
      this.sendJson({ t: 'reject', id: m.id, reason: transfer.error });
      this.changed(true);
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
