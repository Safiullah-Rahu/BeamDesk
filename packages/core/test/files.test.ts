import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileTransfers, isRiskyFileName, sanitizeFileName, type FileSink, type Transfer } from '../src/files.ts';

/** A pair of in-memory "data channels" that behave enough like RTCDataChannel for FileTransfers. */
class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'arraybuffer';
  peer!: FakeChannel;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    const size = typeof data === 'string' ? data.length : (data as ArrayBuffer).byteLength;
    this.bufferedAmount += size;
    const copy = typeof data === 'string' ? data : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data.slice(0);
    setTimeout(() => {
      this.bufferedAmount -= size;
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.dispatchEvent(new Event('bufferedamountlow'));
      this.peer.dispatchEvent(Object.assign(new Event('message'), { data: copy }));
    }, 0);
  }

  static pair(): [FakeChannel, FakeChannel] {
    const a = new FakeChannel();
    const b = new FakeChannel();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }
}

function memorySink(store: Map<string, Uint8Array[]>, name: string): FileSink {
  const chunks: Uint8Array[] = [];
  return {
    write: (c) => void chunks.push(new Uint8Array(c)),
    close: () => {
      store.set(name, chunks);
      return `mem://${name}`;
    },
    abort: () => undefined,
  };
}

const waitFor = async (fn: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('files: a multi-chunk file arrives intact', async () => {
  const [a, b] = FakeChannel.pair();
  const store = new Map<string, Uint8Array[]>();
  const sender = new FileTransfers(() => null, () => false);
  const receiver = new FileTransfers((m) => memorySink(store, m.name), () => true);
  sender.attach(a as unknown as RTCDataChannel);
  receiver.attach(b as unknown as RTCDataChannel);

  const data = new Uint8Array(300_000).map((_, i) => (i * 31) % 251);
  let received: Transfer | null = null;
  receiver.on('received', (t) => (received = t));
  sender.send([new File([data], '../report.bin')]);

  await waitFor(() => received !== null);
  const parts = store.get('report.bin')!;
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    joined.set(p, off);
    off += p.length;
  }
  assert.deepEqual(joined, data);
  assert.equal(received!.location, 'mem://report.bin');
  await waitFor(() => sender.list()[0].state === 'done');
});

test('files: receiver without permission rejects and the sender stops', async () => {
  const [a, b] = FakeChannel.pair();
  const sender = new FileTransfers(() => null, () => false);
  const receiver = new FileTransfers(() => null, () => false);
  sender.attach(a as unknown as RTCDataChannel);
  receiver.attach(b as unknown as RTCDataChannel);
  sender.send([new File([new Uint8Array(2_000_000)], 'big.bin')]);
  await waitFor(() => ['failed', 'done'].includes(sender.list()[0].state));
  assert.equal(sender.list()[0].state, 'failed');
  assert.match(sender.list()[0].error ?? '', /not allowed/);
  // Refusals leave no trace: a peer cannot flood the transfer list.
  assert.equal(receiver.list().length, 0);
});

test('files: a sink that opens after the transfer was cancelled is released', async () => {
  const [a, b] = FakeChannel.pair();
  let aborted = 0;
  let release!: () => void;
  const opened = new Promise<void>((r) => (release = r));
  const sender = new FileTransfers(() => null, () => false);
  const receiver = new FileTransfers(
    async () => {
      await opened; // e.g. the desktop disk sink waiting for IPC
      return { write: () => undefined, close: () => undefined, abort: () => void aborted++ };
    },
    () => true,
  );
  sender.attach(a as unknown as RTCDataChannel);
  receiver.attach(b as unknown as RTCDataChannel);
  sender.send([new File([new Uint8Array(1000)], 'x.bin')]);
  await waitFor(() => receiver.list().length === 1);
  receiver.cancel(receiver.list()[0].id);
  release();
  await waitFor(() => aborted === 1);
  assert.equal(receiver.list()[0].state, 'cancelled');
});

test('files: nothing is streamed until the receiver consents, and a decline stops the sender', async () => {
  const [a, b] = FakeChannel.pair();
  let opened = 0;
  const asked: string[] = [];
  let answer!: (ok: boolean) => void;
  const sender = new FileTransfers(() => null, () => false);
  const receiver = new FileTransfers(
    () => {
      opened++;
      return null;
    },
    () => true,
    (meta) => {
      asked.push(meta.name);
      return new Promise((r) => (answer = r));
    },
  );
  let binaryFrames = 0;
  b.addEventListener('message', (e) => {
    if (typeof (e as MessageEvent).data !== 'string') binaryFrames++;
  });
  sender.attach(a as unknown as RTCDataChannel);
  receiver.attach(b as unknown as RTCDataChannel);
  sender.send([new File([new Uint8Array(500_000)], 'setup.exe')]);
  await waitFor(() => asked.length === 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(binaryFrames, 0, 'no data before consent');
  assert.equal(sender.list()[0].state, 'queued');
  answer(false);
  await waitFor(() => sender.list()[0].state !== 'queued');
  assert.equal(sender.list()[0].state, 'failed');
  assert.match(sender.list()[0].error ?? '', /Declined/);
  assert.equal(receiver.list()[0].state, 'cancelled');
  assert.equal(opened, 0, 'no file is created when the user declines');
  assert.equal(binaryFrames, 0);
});

test('files: data sent before acceptance fails the transfer', async () => {
  const [a, b] = FakeChannel.pair();
  const writes: number[] = [];
  const receiver = new FileTransfers(() => ({ write: (c) => void writes.push(c.length), close: () => undefined, abort: () => undefined }), () => true, () => new Promise(() => undefined));
  receiver.attach(b as unknown as RTCDataChannel);
  a.send(JSON.stringify({ t: 'start', id: 7, name: 'a.txt', size: 10, mime: 'text/plain' }));
  const frame = new Uint8Array(14);
  new DataView(frame.buffer).setUint32(0, 7);
  a.send(frame);
  await waitFor(() => receiver.list()[0]?.state === 'failed');
  assert.deepEqual(writes, []);
});

test('files: at most four incoming files at once', async () => {
  const [a, b] = FakeChannel.pair();
  const replies: any[] = [];
  a.addEventListener('message', (e) => replies.push(JSON.parse((e as MessageEvent).data)));
  const receiver = new FileTransfers(() => null, () => true, () => new Promise(() => undefined));
  receiver.attach(b as unknown as RTCDataChannel);
  for (let id = 1; id <= 6; id++) a.send(JSON.stringify({ t: 'start', id, name: `f${id}`, size: 1, mime: '' }));
  await waitFor(() => replies.length === 2);
  assert.deepEqual(replies.map((r) => [r.t, r.id]), [['reject', 5], ['reject', 6]]);
  assert.equal(receiver.list().length, 4);
});

test('files: names cannot hide their real type', () => {
  assert.equal(sanitizeFileName('invoice.pdf          .exe'), 'invoice.pdf .exe');
  assert.equal(sanitizeFileName('photo\u202egpj.exe'), 'photo_gpj.exe');
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.ok(isRiskyFileName('invoice.pdf .exe'));
  assert.ok(isRiskyFileName('Setup.MSI'));
  assert.ok(isRiskyFileName('run.sh.'));
  assert.ok(!isRiskyFileName('report.pdf'));
  assert.ok(!isRiskyFileName('exe'));
});
