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
  /** New device IDs one network (IPv4 address or IPv6 /64) may register per hour (0 = unlimited). */
  newDevicesPerHour: number;
  /** New device IDs the whole server accepts per hour (0 = unlimited). */
  newDevicesGlobalPerHour: number;
  /** Upper bound on remembered device IDs; new IDs are refused once it is reached. */
  maxDevices: number;
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
    turnTtl: Math.min(int(env.TURN_TTL, 3600), 24 * 3600),
    iceServersJson: env.ICE_SERVERS_JSON || '',
    maxClients: int(env.MAX_CLIENTS, 20_000),
    maxConnectionsPerIp: int(env.MAX_CONNECTIONS_PER_IP, 50),
    newDevicesPerHour: env.NEW_DEVICES_PER_HOUR === '0' ? 0 : int(env.NEW_DEVICES_PER_HOUR, 60),
    newDevicesGlobalPerHour: env.NEW_DEVICES_GLOBAL_PER_HOUR === '0' ? 0 : int(env.NEW_DEVICES_GLOBAL_PER_HOUR, 10_000),
    maxDevices: int(env.MAX_DEVICES, 1_000_000),
    trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY || ''),
    downloadUrl: env.DOWNLOAD_URL || 'https://github.com/Safiullah-Rahu/BeamDesk/releases/latest',
  };
}

const PLACEHOLDER_SECRETS = new Set(['change-me-to-a-long-random-string', 'changeme', 'secret', 'password']);

/** Problems that make the configuration unsafe to run with (startup refuses). */
export function configErrors(config: Config): string[] {
  const errors: string[] = [];
  if (config.turnUrls.length && !config.turnSecret && !(config.turnUsername && config.turnPassword)) {
    errors.push('TURN_URLS is set but neither TURN_SECRET nor TURN_USERNAME/TURN_PASSWORD is.');
  }
  if (config.turnSecret && (config.turnSecret.length < 16 || PLACEHOLDER_SECRETS.has(config.turnSecret.toLowerCase()))) {
    errors.push('TURN_SECRET must be a random string of at least 16 characters (e.g. `openssl rand -hex 32`).');
  }
  if (config.accessKey && config.accessKey.length < 8) errors.push('ACCESS_KEY must be at least 8 characters long.');
  return errors;
}

/** Risky but legal settings worth a warning in the log. */
export function configWarnings(config: Config): string[] {
  const warnings: string[] = [];
  if (config.turnUrls.length && !config.turnSecret && config.turnUsername && !config.accessKey) {
    warnings.push('Static TURN credentials are handed to every client of this public server; anyone can use your relay. Prefer TURN_SECRET, or set ACCESS_KEY.');
  }
  if (config.iceServersJson && !config.accessKey) {
    warnings.push('ICE_SERVERS_JSON credentials are handed to every client of this public server.');
  }
  if (config.trustProxy) warnings.push('TRUST_PROXY is on: make sure only your reverse proxy can reach this port, or clients can fake their IP address.');
  return warnings;
}
