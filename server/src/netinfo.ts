/**
 * What this computer's network looks like, for host mode: its addresses on the home network and
 * on Tailscale, the router (default gateway), and what kind of address an IP is.
 * Nothing here sends a packet to the internet.
 */
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';

export type AddressKind = 'loopback' | 'private' | 'cgnat' | 'link-local' | 'public' | 'reserved';

function v4(ip: string): number[] | null {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').map(Number);
}

/** Classifies an IPv4 address (anything else is 'reserved'). */
export function classifyIPv4(ip: string): AddressKind {
  const b = v4(ip);
  if (!b) return 'reserved';
  const [a, c] = b;
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168)) return 'private';
  if (a === 100 && c >= 64 && c <= 127) return 'cgnat'; // RFC 6598, also used by Tailscale
  if (a === 169 && c === 254) return 'link-local';
  if (a === 0 || a >= 224 || (a === 198 && (c === 18 || c === 19))) return 'reserved';
  // Everything else, including the documentation ranges (192.0.2.0/24, 198.51.100.0/24,
  // 203.0.113.0/24) that examples and test networks use in place of a real internet address.
  return 'public';
}

export interface LocalAddresses {
  /** IPv4 addresses on the home network (Wi-Fi/Ethernet), best first. */
  lan: string[];
  /** Tailscale (100.64.0.0/10) addresses. */
  tailscale: string[];
  /** Public IPv4 addresses on an interface (computer directly on the internet). */
  public: string[];
}

/** Virtual adapters that are never the home network (VMs, containers, WSL). */
const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vboxnet|vethernet|lxc|lxd|cni|flannel|podman|zt|wg)/i;

export function localAddresses(primary?: string | null): LocalAddresses {
  const out: LocalAddresses = { lan: [], tailscale: [], public: [] };
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const kind = classifyIPv4(a.address);
      if (kind === 'cgnat') out.tailscale.push(a.address);
      else if (kind === 'private' && !VIRTUAL.test(name) && !/^192\.168\.56\./.test(a.address)) out.lan.push(a.address);
      else if (kind === 'public') out.public.push(a.address);
    }
  }
  if (primary && out.lan.includes(primary)) out.lan = [primary, ...out.lan.filter((x) => x !== primary)];
  return out;
}

/**
 * The address the operating system would use for the internet (the interface with the default
 * route). A connected UDP socket picks its source address without sending anything.
 */
export function primaryAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const done = (v: string | null) => {
      try {
        s.close();
      } catch {
        /* closed */
      }
      resolve(v);
    };
    s.on('error', () => done(null));
    try {
      // TEST-NET-1: never routed, only used to look up the default route.
      s.connect(9, '192.0.2.1', () => {
        try {
          const a = s.address().address;
          done(net.isIPv4(a) && a !== '0.0.0.0' && classifyIPv4(a) !== 'loopback' ? a : null);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) => {
    execFile(cmd, args, { timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });

/** Parses /proc/net/route (Linux): the gateway of the default route. */
export function gatewayFromProcRoute(text: string): string | null {
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[1] !== '00000000' || f[2] === '00000000') continue;
    const n = Number.parseInt(f[2], 16);
    if (!Number.isFinite(n)) continue;
    return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.');
  }
  return null;
}

/** Parses `route print -4 0.0.0.0` (Windows) or `route -n get default` (macOS). */
export function gatewayFromRouteOutput(text: string, lan?: string | null): string | null {
  const mac = /gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(text);
  if (mac) return mac[1];
  let best: { gw: string; metric: number } | null = null;
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 5 && f[0] === '0.0.0.0' && f[1] === '0.0.0.0' && net.isIPv4(f[2])) {
      const metric = Number(f[4]) || 9999;
      if (lan && f[3] === lan) return f[2];
      if (!best || metric < best.metric) best = { gw: f[2], metric };
    }
  }
  return best?.gw ?? null;
}

/** The router's address (default gateway), or null if it cannot be found. */
export async function defaultGateway(lan?: string | null): Promise<string | null> {
  let gw: string | null = null;
  if (process.platform === 'linux') {
    try {
      gw = gatewayFromProcRoute(fs.readFileSync('/proc/net/route', 'utf8'));
    } catch {
      /* not available */
    }
  } else if (process.platform === 'win32') {
    gw = gatewayFromRouteOutput(await run('route', ['print', '-4', '0.0.0.0']), lan);
  } else if (process.platform === 'darwin') {
    gw = gatewayFromRouteOutput(await run('/sbin/route', ['-n', 'get', 'default']));
  }
  return gw && classifyIPv4(gw) === 'private' ? gw : null;
}
