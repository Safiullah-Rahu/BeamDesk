/**
 * WebSockets to home servers, opened by the main process for the UI.
 *
 * A home server has a self-signed certificate that the app must accept only if its SHA-256
 * fingerprint matches the connection code. Chromium cannot do that reliably (it caches a refused
 * certificate, so a corrected code would keep failing), so these connections use Node's TLS with
 * the check done here, before a single message passes. Only addresses of the joined home server
 * or this computer's own server can be opened, and only at /ws.
 */
import type { WebContents } from 'electron';
import WebSocket from 'ws';
import { fingerprintOf } from '@beamdesk/server/cert';
import { LIMITS } from '@beamdesk/core/protocol';
import type { PinnedSocketEvent } from '@beamdesk/core/bridge';

const MAX_SOCKETS = 16;

export class PinnedSockets {
  private readonly pinFor: (host: string) => string | null;
  private readonly sockets = new Map<number, { ws: WebSocket; owner: WebContents }>();
  private nextId = 1;

  constructor(pinFor: (host: string) => string | null) {
    this.pinFor = pinFor;
  }

  open(owner: WebContents, url: unknown): number | null {
    if (typeof url !== 'string' || url.length > 300) return null;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const pin = this.pinFor(u.hostname.toLowerCase());
    if (u.protocol !== 'wss:' || u.pathname !== '/ws' || u.search || !pin) return null;
    if ([...this.sockets.values()].filter((s) => s.owner === owner).length >= MAX_SOCKETS) return null;

    const id = this.nextId++;
    // No certificate authority vouches for a home server: the fingerprint check is the verification.
    const ws = new WebSocket(u.toString(), { rejectUnauthorized: false, maxPayload: LIMITS.wsMessageBytes, perMessageDeflate: false, handshakeTimeout: 10_000, minVersion: 'TLSv1.3' });
    let verified = false;
    const emit = (e: PinnedSocketEvent) => {
      if (!owner.isDestroyed()) owner.send('pws:event', e);
    };
    ws.on('upgrade', (res) => {
      const cert = (res.socket as import('node:tls').TLSSocket).getPeerCertificate?.();
      verified = !!cert?.raw && fingerprintOf(cert.raw) === pin;
      if (!verified) ws.terminate();
    });
    ws.on('open', () => {
      if (verified) emit({ id, type: 'open' });
      else ws.terminate();
    });
    ws.on('message', (data, isBinary) => {
      if (verified && !isBinary) emit({ id, type: 'message', data: data.toString() });
    });
    ws.on('close', (code, reason) => {
      this.sockets.delete(id);
      emit({ id, type: 'close', code: verified ? code : 1015, reason: verified ? reason.toString().slice(0, 123) : 'certificate does not match the connection code' });
    });
    ws.on('error', () => {
      /* 'close' follows */
    });
    this.sockets.set(id, { ws, owner });
    return id;
  }

  send(owner: WebContents, id: unknown, data: unknown): void {
    const s = this.sockets.get(Number(id));
    if (!s || s.owner !== owner || typeof data !== 'string' || data.length > LIMITS.wsMessageBytes) return;
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(data);
  }

  close(owner: WebContents, id: unknown, code?: unknown, reason?: unknown): void {
    const s = this.sockets.get(Number(id));
    if (!s || s.owner !== owner) return;
    const c = Number.isInteger(code) && ((code as number) === 1000 || ((code as number) >= 3000 && (code as number) <= 4999)) ? (code as number) : 1000;
    try {
      s.ws.close(c, typeof reason === 'string' ? reason.slice(0, 123) : undefined);
    } catch {
      s.ws.terminate();
    }
  }

  /** The page went away (reload, crash): drop its sockets. */
  closeAll(owner: WebContents): void {
    for (const [id, s] of this.sockets) {
      if (s.owner !== owner) continue;
      this.sockets.delete(id);
      s.ws.terminate();
    }
  }
}
