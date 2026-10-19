/**
 * BeamDesk signaling server.
 *
 * Responsibilities (and nothing more - screen content never touches this server):
 *  - verify that each device owns the ID it registers (Ed25519 signature over a challenge),
 *  - relay connection setup messages between two online devices,
 *  - answer presence queries for the address book,
 *  - hand out STUN/TURN configuration (with short-lived TURN credentials),
 *  - serve the web app.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { deviceIdFromPublicKey, registrationMessage, verifySignature } from '@beamdesk/core/identity';
import { APP_VERSION, LIMITS, type ServerToClient, type SignalKind } from '@beamdesk/core/protocol';
import { fromBase64Url } from '@beamdesk/core/util';
import type { Config } from './config.ts';
import { DeviceRegistry } from './registry.ts';
import { hasTurn, iceServersFor } from './ice.ts';
import { SECURITY_HEADERS, StaticSite } from './static.ts';

const SIGNAL_KINDS = new Set<SignalKind>(['offer', 'answer', 'ice', 'auth', 'pending', 'auth-result', 'bye', 'invite']);

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private readonly rate: number;
  private readonly burst: number;

  constructor(rate: number, burst: number) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
  }
  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

interface Client {
  ws: WebSocket;
  ip: string;
  challenge: string;
  id: string | null;
  name: string;
  alive: boolean;
  messages: TokenBucket;
  /** Connection requests and invites are rate limited separately (anti-spam). */
  requests: TokenBucket;
  registerTimer: ReturnType<typeof setTimeout> | null;
}

export interface BeamServer {
  http: http.Server;
  listen(): Promise<number>;
  close(): Promise<void>;
  stats(): { clients: number; registered: number; devices: number };
}

export function createBeamServer(config: Config): BeamServer {
  const site = new StaticSite(config.webRoot);
  const registry = new DeviceRegistry(config.dataDir);
  const online = new Map<string, Client>();
  const perIp = new Map<string, number>();
  const turn = hasTurn(config);
  const serverInfo = { name: config.serverName, version: APP_VERSION, requiresKey: !!config.accessKey, turn };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/healthz' || url === '/api/health') {
      return json(res, 200, { ok: true, version: APP_VERSION, online: online.size });
    }
    if (url === '/api/info') {
      return json(res, 200, { ...serverInfo, downloadUrl: config.downloadUrl });
    }
    if (site.handle(req, res)) return;
    if (url === '/' && !site.enabled) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`${config.serverName} signaling server ${APP_VERSION} is running.\nBuild the web app (npm run build:web) to serve it here.\n`);
    }
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found\n');
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.wsMessageBytes, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const ip = clientIp(req, config.trustProxy);
    if ((perIp.get(ip) ?? 0) >= config.maxConnectionsPerIp || wss.clients.size >= config.maxClients) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
  });

  function onConnection(ws: WebSocket, ip: string): void {
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    const client: Client = {
      ws,
      ip,
      challenge: crypto.randomBytes(32).toString('base64url'),
      id: null,
      name: '',
      alive: true,
      messages: new TokenBucket(40, 200),
      requests: new TokenBucket(0.5, 15),
      registerTimer: null,
    };
    client.registerTimer = setTimeout(() => {
      if (!client.id) ws.close(4001, 'register timeout');
    }, 10_000);

    ws.on('pong', () => (client.alive = true));
    ws.on('message', (data, isBinary) => onMessage(client, data, isBinary));
    ws.on('close', () => {
      if (client.registerTimer) clearTimeout(client.registerTimer);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
      if (client.id && online.get(client.id) === client) online.delete(client.id);
    });
    ws.on('error', () => ws.terminate());
    send(client, { t: 'hello', challenge: client.challenge, server: serverInfo });
  }

  function onMessage(client: Client, data: RawData, isBinary: boolean): void {
    if (isBinary) return fail(client, 'bad-request', 'binary frames are not supported');
    if (!client.messages.take()) return fail(client, 'rate-limited', 'slow down');
    let m: any;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return fail(client, 'bad-request', 'invalid JSON');
    }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return fail(client, 'bad-request', 'invalid message');

    if (m.t === 'register') return onRegister(client, m);
    if (m.t === 'ping') return send(client, { t: 'pong' });
    if (!client.id) return fail(client, 'not-registered', 'register first');

    switch (m.t) {
      case 'signal':
        return onSignal(client, m);
      case 'presence': {
        const ids: unknown[] = Array.isArray(m.ids) ? m.ids.slice(0, 100) : [];
        const result: Record<string, boolean> = {};
        for (const id of ids) if (typeof id === 'string' && /^\d{9}$/.test(id)) result[id] = online.has(id);
        return send(client, { t: 'presence', rid: Number(m.rid) || 0, online: result });
      }
      case 'ice':
        return send(client, { t: 'ice', rid: Number(m.rid) || 0, ice: iceServersFor(config, client.id) as RTCIceServer[] });
      default:
        return fail(client, 'bad-request', 'unknown message type');
    }
  }

  function onRegister(client: Client, m: any): void {
    if (client.id) return fail(client, 'bad-request', 'already registered');
    if (config.accessKey && !safeEqual(String(m.key ?? ''), config.accessKey)) {
      return fail(client, 'access-key', 'This server requires a valid access key (Settings → Network).', true);
    }
    if (typeof m.pk !== 'string' || typeof m.sig !== 'string') return fail(client, 'bad-request', 'missing key', true);
    let id: string;
    try {
      id = deviceIdFromPublicKey(fromBase64Url(m.pk));
    } catch {
      return fail(client, 'bad-request', 'invalid key', true);
    }
    if (!verifySignature(m.pk, registrationMessage(client.challenge), m.sig)) {
      return fail(client, 'bad-signature', 'signature check failed', true);
    }
    if (!registry.claim(id, m.pk)) {
      return fail(client, 'id-conflict', 'This ID belongs to another device.', true);
    }
    const previous = online.get(id);
    if (previous && previous !== client) {
      send(previous, { t: 'replaced' });
      previous.id = null;
      previous.ws.close(4002, 'replaced');
    }
    if (client.registerTimer) clearTimeout(client.registerTimer);
    client.id = id;
    client.name = typeof m.name === 'string' ? m.name.slice(0, LIMITS.nameChars) : '';
    online.set(id, client);
    send(client, { t: 'registered', id, ice: iceServersFor(config, id) as RTCIceServer[] });
  }

  function onSignal(client: Client, m: any): void {
    const { to, sid, kind } = m;
    if (typeof to !== 'string' || !/^\d{9}$/.test(to)) return fail(client, 'bad-request', 'invalid target');
    if (typeof sid !== 'string' || sid.length > 64 || !SIGNAL_KINDS.has(kind)) return fail(client, 'bad-request', 'invalid signal');
    if (to === client.id) return fail(client, 'bad-request', 'cannot signal yourself');
    const expensive = (kind === 'offer' && !m.data?.restart) || kind === 'invite';
    if (expensive && !client.requests.take()) {
      return send(client, { t: 'undeliverable', to, sid, reason: 'rate-limited' });
    }
    const target = online.get(to);
    if (!target) return send(client, { t: 'undeliverable', to, sid, reason: 'offline' });
    send(target, { t: 'signal', from: client.id!, sid, kind, data: m.data });
  }

  function send(client: Client, msg: ServerToClient): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
  }

  function fail(client: Client, code: Extract<ServerToClient, { t: 'error' }>['code'], message: string, fatal = false): void {
    send(client, { t: 'error', code, message, fatal });
    if (fatal) client.ws.close(4003, code);
  }

  // Drop connections that stopped answering pings (sleeping laptops, dead NAT mappings).
  const heartbeat = setInterval(() => {
    for (const c of online.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    http: server,
    listen: () =>
      new Promise((resolve) => {
        server.listen(config.port, config.host, () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : config.port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        registry.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
    stats: () => ({ clients: wss.clients.size, registered: online.size, devices: registry.size }),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
