/** Server configuration from environment variables (see docs/SELF_HOSTING.md). */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export interface Config {
  port: number;
  host: string;
  serverName: string;
  webRoot: string | null;
  dataDir: string;
  accessKey: string;
  stunUrls: string[];
  turnUrls: string[];
  turnSecret: string;
  turnUsername: string;
  turnPassword: string;
  turnTtl: number;
  iceServersJson: string;
  maxClients: number;
  maxConnectionsPerIp: number;
  trustProxy: boolean;
  downloadUrl: string;
}

const list = (v: string | undefined, fallback: string[] = []) =>
  v === undefined ? fallback : v.split(',').map((s) => s.trim()).filter(Boolean);

const int = (v: string | undefined, fallback: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function defaultWebRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, '../web'), // docker image layout: /app/dist/server.mjs + /app/web
    path.resolve(here, '../../apps/web/dist'), // monorepo: server/src or server/dist
  ]) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: env.PORT !== undefined && /^\d+$/.test(env.PORT) ? Number(env.PORT) : 8080,
    host: env.HOST || '0.0.0.0',
    serverName: (env.SERVER_NAME || 'BeamDesk').slice(0, 64),
    webRoot: env.WEB_ROOT === '' ? null : env.WEB_ROOT ? path.resolve(env.WEB_ROOT) : defaultWebRoot(),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    accessKey: env.ACCESS_KEY || '',
    stunUrls: list(env.STUN_URLS, ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']),
    turnUrls: list(env.TURN_URLS),
    turnSecret: env.TURN_SECRET || '',
    turnUsername: env.TURN_USERNAME || '',
    turnPassword: env.TURN_PASSWORD || '',
    turnTtl: int(env.TURN_TTL, 12 * 3600),
    iceServersJson: env.ICE_SERVERS_JSON || '',
    maxClients: int(env.MAX_CLIENTS, 20_000),
    maxConnectionsPerIp: int(env.MAX_CONNECTIONS_PER_IP, 50),
    trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY || ''),
    downloadUrl: env.DOWNLOAD_URL || 'https://github.com/Safiullah-Rahu/BeamDesk/releases/latest',
  };
}
