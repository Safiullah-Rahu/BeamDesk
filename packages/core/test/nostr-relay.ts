/**
 * A small Nostr relay for tests (NIP-01 subset), as strict as the public ones: it checks every
 * event's id and signature, rejects stale ephemeral events and oversized messages, and passes
 * ephemeral events on to matching subscriptions without storing them.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyEvent, type NostrEvent, type NostrFilter } from '../src/nostr.ts';

export interface TestRelay {
  url: string;
  /** Events accepted so far. */
  accepted: NostrEvent[];
  /** Return true to silently lose an event (tests of lost messages). */
  drop: ((e: NostrEvent) => boolean) | null;
  /** Extra delay before an event goes out (tests of reordering). */
  delay: ((e: NostrEvent) => number) | null;
  /** Sends raw text to every subscriber (tests of misbehaving relays). */
  inject(subMessage: (subId: string) => unknown[]): void;
  close(): Promise<void>;
}

const matches = (f: NostrFilter, e: NostrEvent) =>
  (!f.kinds || f.kinds.includes(e.kind)) && (!f['#p'] || e.tags.some((t) => t[0] === 'p' && f['#p']!.includes(t[1]))) && (!f.since || e.created_at >= f.since);

export async function startRelay(): Promise<TestRelay> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 128 * 1024 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const subs = new Map<WebSocket, Map<string, NostrFilter[]>>();
  const relay: TestRelay = {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    accepted: [],
    drop: null,
    delay: null,
    inject(make) {
      for (const [ws, list] of subs) for (const id of list.keys()) ws.send(JSON.stringify(make(id)));
    },
    close: () =>
      new Promise((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('close', () => subs.delete(ws));
    ws.on('message', (raw) => {
      let m: unknown[];
      try {
        m = JSON.parse(String(raw));
      } catch {
        return ws.send(JSON.stringify(['NOTICE', 'invalid JSON']));
      }
      if (m[0] === 'REQ' && typeof m[1] === 'string') {
        subs.get(ws)?.set(m[1], m.slice(2) as NostrFilter[]);
        return ws.send(JSON.stringify(['EOSE', m[1]]));
      }
      if (m[0] === 'CLOSE' && typeof m[1] === 'string') return void subs.get(ws)?.delete(m[1]);
      if (m[0] !== 'EVENT') return ws.send(JSON.stringify(['NOTICE', 'unknown message']));
      const e = m[1] as NostrEvent;
      const id = (m[1] as { id?: unknown })?.id;
      if (String(raw).length > 65536) return ws.send(JSON.stringify(['OK', id, false, 'invalid: event too large']));
      if (!verifyEvent(e)) return ws.send(JSON.stringify(['OK', id, false, 'invalid: bad id or signature']));
      const age = Date.now() / 1000 - e.created_at;
      if (e.kind >= 20000 && e.kind < 30000 && (age > 60 || age < -900)) return ws.send(JSON.stringify(['OK', e.id, false, 'invalid: stale']));
      relay.accepted.push(e);
      ws.send(JSON.stringify(['OK', e.id, true, '']));
      if (relay.drop?.(e)) return;
      const out = () => {
        for (const [client, list] of subs) {
          for (const [id, filters] of list) if (filters.some((f) => matches(f, e))) client.send(JSON.stringify(['EVENT', id, e]));
        }
      };
      const d = relay.delay?.(e) ?? 0;
      if (d) setTimeout(out, d);
      else out();
    });
  });
  return relay;
}
