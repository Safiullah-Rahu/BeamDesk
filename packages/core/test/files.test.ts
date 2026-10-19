import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileTransfers, type FileSink, type Transfer } from '../src/files.ts';

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
  assert.equal(receiver.list()[0].state, 'failed');
});
