/**
 * Checks the beacon against the real public relays: each relay on its own (does it pass on our
 * ephemeral events, how fast), then a full encrypted tunnel through all of them.
 *
 *   node scripts/check-relays.ts [wss://relay ...]
 *
 * Exits with 1 if fewer than two relays work or the tunnel fails. Run by .github/workflows/relays.yml.
 */
import { BEACON_KIND, BeaconServer, BeaconSocket, beaconKeypair, DEFAULT_RELAYS } from '../packages/core/src/beacon.ts';
import { nostrKeypair, signEvent } from '../packages/core/src/nostr.ts';
import { randomBytes, toBase64Url } from '../packages/core/src/util.ts';

const relays = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_RELAYS;

/** Subscribes, publishes one event and waits for it to come back. */
function probe(url: string): Promise<{ ok: boolean; ms: number; note: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const key = nostrKeypair();
    const topic = Buffer.from(randomBytes(32)).toString('hex');
    let ws: WebSocket;
    let note = '';
    const done = (ok: boolean, why = '') => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ ok, ms: Date.now() - start, note: why || note });
    };
    const timer = setTimeout(() => done(false, note || 'timeout'), 10_000);
    try {
      ws = new WebSocket(url);
    } catch (err) {
      return done(false, (err as Error).message);
    }
    const ev = signEvent(key.secret, BEACON_KIND, [['p', topic]], toBase64Url(randomBytes(200)));
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'probe', { kinds: [BEACON_KIND], '#p': [topic], since: Math.floor(Date.now() / 1000) - 60 }]));
    ws.onmessage = (m) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (msg[0] === 'EOSE') ws.send(JSON.stringify(['EVENT', ev]));
      else if (msg[0] === 'OK' && msg[2] === false) note = `refused: ${msg[3]}`;
      else if (msg[0] === 'NOTICE' || msg[0] === 'CLOSED') note = `${msg[0]}: ${msg.at(-1)}`;
      else if (msg[0] === 'AUTH') note = 'asks for authentication';
      else if (msg[0] === 'EVENT' && (msg[2] as { id?: string })?.id === ev.id) done(true);
    };
    ws.onerror = () => (note ||= 'connection failed');
    ws.onclose = () => done(false, note || 'closed');
  });
}

async function tunnel(urls: string[]): Promise<{ ok: boolean; ms: number }> {
  const start = Date.now();
  const key = beaconKeypair();
  const psk = randomBytes(16);
  const server = new BeaconServer({
    secret: key.secret,
    psk,
    relays: urls,
    info: () => ({ name: 'relay check', addresses: [] }),
    onConnection: (c) => (c.onframe = (f) => c.send(`echo:${f}`)),
  });
  server.start();
  await new Promise((r) => setTimeout(r, 3000)); // let the server subscribe everywhere
  const s = new BeaconSocket('beacon:', { key: toBase64Url(key.public), psk: toBase64Url(psk), relays: urls }, { timeoutMs: 30_000 });
  const ok = await new Promise<boolean>((resolve) => {
    s.onopen = () => s.send('ping '.repeat(4000)); // 20 KB: two chunks
    s.onmessage = (e) => resolve(e.data === `echo:${'ping '.repeat(4000)}`);
    s.onclose = () => resolve(false);
  });
  s.close();
  server.stop();
  return { ok, ms: Date.now() - start - 3000 };
}

const results = await Promise.all(relays.map(async (url) => ({ url, ...(await probe(url)) })));
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.url.padEnd(32)} ${r.ok ? `${r.ms} ms` : r.note}`);
const working = results.filter((r) => r.ok).map((r) => r.url);
console.log(`${working.length} of ${relays.length} relays pass on beacon events.`);
const t = working.length ? await tunnel(relays) : { ok: false, ms: 0 };
console.log(`Encrypted tunnel through all relays: ${t.ok ? `ok (${t.ms} ms to open and echo 20 KB)` : 'FAILED'}`);
process.exit(working.length >= 2 && t.ok ? 0 : 1);
