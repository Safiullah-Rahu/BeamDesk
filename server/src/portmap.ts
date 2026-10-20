/**
 * Opens host mode's port on the home router, the way games and video calls do: UPnP IGD first,
 * NAT-PMP (Apple routers and others) second. Mappings are leased and renewed while host mode
 * runs, and removed when it stops, so nothing stays open after BeamDesk is turned off.
 *
 * Only the router is ever contacted, and only for this computer's own address and port.
 */
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import { classifyIPv4 } from './netinfo.ts';

export type Protocol = 'TCP' | 'UDP';

export interface PortRequest {
  protocol: Protocol;
  port: number;
}

export interface Mapping {
  protocol: Protocol;
  internalPort: number;
  externalPort: number;
}

export interface PortMapResult {
  method: 'upnp' | 'nat-pmp';
  /** The router's internet address (null if it would not say). */
  externalIp: string | null;
  mappings: Mapping[];
}

export interface PortMapperOptions {
  /** This computer's address on the home network. */
  internalAddress: string;
  ports: PortRequest[];
  description?: string;
  /** Lease in seconds (renewed at half time). */
  lifetime?: number;
  /** The router, for NAT-PMP (see netinfo.defaultGateway). */
  gateway?: string | null;
  /** Called whenever a renewal changes the result (e.g. a new external address) or fails. */
  onChange?: (result: PortMapResult | null, error?: string) => void;
  /** Tests: where to send SSDP searches, and the NAT-PMP port. */
  ssdpTarget?: { address: string; port: number };
  natPmpPort?: number;
  timeoutMs?: number;
}

const MAX_BODY = 64 * 1024;

// ------------------------------------------------------------------ UPnP IGD

interface Igd {
  controlUrl: string;
  serviceType: string;
}

const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

/** SSDP search: description URLs of routers that answered (each on the answering device itself). */
export function discoverGateways(localAddress: string, timeoutMs = 2500, target = { address: '239.255.255.250', port: 1900 }): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    let timer: ReturnType<typeof setTimeout>;
    let again: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timer);
      clearTimeout(again);
      try {
        s.close();
      } catch {
        /* closed */
      }
      resolve([...found]);
    };
    s.on('error', done);
    s.on('message', (msg, rinfo) => {
      if (msg.length > 4096 || found.size >= 8) return;
      const location = /^location:\s*(\S+)/im.exec(msg.toString('latin1'))?.[1];
      if (!location) return;
      try {
        const u = new URL(location);
        // The description must live on the device that answered: an answer cannot point us anywhere else.
        if (u.protocol === 'http:' && u.hostname === rinfo.address && ['private', 'loopback'].includes(classifyIPv4(rinfo.address))) found.add(u.toString());
      } catch {
        /* not a URL */
      }
    });
    s.bind(0, localAddress, () => {
      try {
        if (target.address.startsWith('239.')) s.setMulticastInterface(localAddress);
      } catch {
        /* best effort */
      }
      const send = () => {
        for (const st of SEARCH_TARGETS) {
          const req = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
          s.send(req, target.port, target.address);
        }
      };
      send();
      again = setTimeout(send, Math.min(400, timeoutMs / 2)); // UDP: ask twice
      timer = setTimeout(done, timeoutMs);
    });
  });
}

function httpRequest(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method ?? 'GET', headers: opts.headers, timeout: opts.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy(new Error('response too large'));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(opts.body);
  });
}

const tag = (xml: string, name: string) => new RegExp(`<(?:\\w+:)?${name}>\\s*([^<]*?)\\s*</(?:\\w+:)?${name}>`, 'i').exec(xml)?.[1];

/** Finds the WAN connection service in a device description. */
export function parseDescription(xml: string, location: string): Igd | null {
  const base = tag(xml, 'URLBase') || location;
  const services = xml.match(/<service>[\s\S]*?<\/service>/gi) ?? [];
  const rank = (t: string) => (/WANIPConnection:2/.test(t) ? 0 : /WANIPConnection:1/.test(t) ? 1 : /WANPPPConnection:1/.test(t) ? 2 : 9);
  let best: Igd | null = null;
  for (const block of services) {
    const serviceType = tag(block, 'serviceType') ?? '';
    const control = tag(block, 'controlURL');
    if (!control || rank(serviceType) === 9) continue;
    let controlUrl: string;
    try {
      const u = new URL(control.replace(/&amp;/g, '&'), base);
      // Same device as the description, plain HTTP: never anywhere else.
      if (u.protocol !== 'http:' || u.hostname !== new URL(location).hostname) continue;
      controlUrl = u.toString();
    } catch {
      continue;
    }
    if (!best || rank(serviceType) < rank(best.serviceType)) best = { controlUrl, serviceType };
  }
  return best;
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

class UpnpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

async function soap(igd: Igd, action: string, args: [string, string | number][], timeoutMs: number): Promise<string> {
  const body =
    `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${xmlEscape(igd.serviceType)}">` +
    args.map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`).join('') +
    `</u:${action}></s:Body></s:Envelope>\r\n`;
  const res = await httpRequest(igd.controlUrl, {
    method: 'POST',
    timeoutMs,
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${igd.serviceType}#${action}"`, 'Content-Length': String(Buffer.byteLength(body)) },
    body,
  });
  if (res.status !== 200) {
    const code = Number(tag(res.body, 'errorCode') ?? res.status);
    throw new UpnpError(code, tag(res.body, 'errorDescription') ?? `HTTP ${res.status}`);
  }
  return res.body;
}

// ------------------------------------------------------------------ NAT-PMP (RFC 6886)

function natPmpRequest(gateway: string, request: Buffer, port: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    let delay = 250;
    let elapsed = 0;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (err: Error | null, buf?: Buffer) => {
      clearTimeout(timer);
      try {
        s.close();
      } catch {
        /* closed */
      }
      if (err) reject(err);
      else resolve(buf!);
    };
    s.on('error', (e) => finish(e));
    s.on('message', (msg, rinfo) => {
      // Only the router itself may answer.
      if (rinfo.address !== gateway || rinfo.port !== port) return;
      if (msg.length < 8 || msg[0] !== 0 || msg[1] !== 128 + request[1]) return;
      const result = msg.readUInt16BE(2);
      if (result !== 0) return finish(new Error(`NAT-PMP error ${result}`));
      finish(null, msg);
    });
    const send = () => {
      s.send(request, port, gateway);
      elapsed += delay;
      if (elapsed > timeoutMs) {
        timer = setTimeout(() => finish(new Error('the router did not answer (NAT-PMP)')), delay);
        return;
      }
      timer = setTimeout(send, delay);
      delay *= 2;
    };
    s.bind(0, () => send());
  });
}

// ------------------------------------------------------------------ mapper

export class PortMapper {
  private readonly opts: PortMapperOptions;
  private igd: Igd | null = null;
  private current: PortMapResult | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private permanent = false;
  private stopped = false;

  constructor(opts: PortMapperOptions) {
    this.opts = opts;
  }

  get result(): PortMapResult | null {
    return this.current;
  }

  private get lifetime(): number {
    return this.opts.lifetime ?? 3600;
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? 3000;
  }

  /** Maps every port. Throws with a message for people if neither UPnP nor NAT-PMP worked. */
  async start(): Promise<PortMapResult> {
    this.stopped = false;
    const errors: string[] = [];
    try {
      this.current = await this.mapUpnp();
    } catch (err) {
      errors.push(`UPnP: ${(err as Error).message}`);
      try {
        this.current = await this.mapNatPmp();
      } catch (err2) {
        errors.push(`NAT-PMP: ${(err2 as Error).message}`);
      }
    }
    if (!this.current) throw new Error(errors.join('; '));
    if (this.stopped) {
      await this.stop();
      throw new Error('stopped');
    }
    this.renewTimer = setInterval(() => void this.renew(), (this.permanent ? 600 : this.lifetime / 2) * 1000);
    this.renewTimer.unref?.();
    return this.current;
  }

  private async renew(): Promise<void> {
    if (!this.current || this.stopped) return;
    try {
      const next = this.current.method === 'upnp' ? await this.mapUpnp() : await this.mapNatPmp();
      const changed = JSON.stringify(next) !== JSON.stringify(this.current);
      this.current = next;
      if (changed) this.opts.onChange?.(next);
    } catch (err) {
      this.opts.onChange?.(this.current, (err as Error).message);
    }
  }

  private async findIgd(): Promise<Igd> {
    if (this.igd) return this.igd;
    const locations = await discoverGateways(this.opts.internalAddress, this.timeoutMs, this.opts.ssdpTarget);
    if (!locations.length) throw new Error('no router answered (UPnP may be turned off on the router)');
    for (const location of locations) {
      try {
        const res = await httpRequest(location, { timeoutMs: this.timeoutMs });
        const igd = res.status === 200 ? parseDescription(res.body, location) : null;
        if (igd) return (this.igd = igd);
      } catch {
        /* try the next one */
      }
    }
    throw new Error('the router does not offer port forwarding over UPnP');
  }

  private async mapUpnp(): Promise<PortMapResult> {
    const igd = await this.findIgd();
    const mappings: Mapping[] = [];
    for (const { protocol, port } of this.opts.ports) {
      const args = (lease: number): [string, string | number][] => [
        ['NewRemoteHost', ''],
        ['NewExternalPort', port],
        ['NewProtocol', protocol],
        ['NewInternalPort', port],
        ['NewInternalClient', this.opts.internalAddress],
        ['NewEnabled', 1],
        ['NewPortMappingDescription', this.opts.description ?? 'BeamDesk'],
        ['NewLeaseDuration', lease],
      ];
      try {
        await soap(igd, 'AddPortMapping', args(this.permanent ? 0 : this.lifetime), this.timeoutMs);
      } catch (err) {
        if (err instanceof UpnpError && err.code === 725) {
          // OnlyPermanentLeasesSupported: map without a lease and remove it ourselves on stop.
          this.permanent = true;
          await soap(igd, 'AddPortMapping', args(0), this.timeoutMs);
        } else if (err instanceof UpnpError && err.code === 718) {
          throw new Error(`port ${port}/${protocol} is already forwarded to another device; pick another port in Advanced`);
        } else {
          throw err;
        }
      }
      mappings.push({ protocol, internalPort: port, externalPort: port });
    }
    let externalIp: string | null = null;
    try {
      const ip = tag(await soap(igd, 'GetExternalIPAddress', [], this.timeoutMs), 'NewExternalIPAddress');
      externalIp = ip && net.isIPv4(ip) ? ip : null;
    } catch {
      /* optional */
    }
    return { method: 'upnp', externalIp, mappings };
  }

  private async mapNatPmp(): Promise<PortMapResult> {
    const gateway = this.opts.gateway;
    if (!gateway) throw new Error('the router address is unknown');
    const port = this.opts.natPmpPort ?? 5351;
    const mappings: Mapping[] = [];
    for (const req of this.opts.ports) {
      const msg = Buffer.alloc(12);
      msg[1] = req.protocol === 'UDP' ? 1 : 2;
      msg.writeUInt16BE(req.port, 4);
      msg.writeUInt16BE(req.port, 6);
      msg.writeUInt32BE(this.lifetime, 8);
      const res = await natPmpRequest(gateway, msg, port, this.timeoutMs);
      if (res.length < 16) throw new Error('bad NAT-PMP answer');
      mappings.push({ protocol: req.protocol, internalPort: req.port, externalPort: res.readUInt16BE(10) });
    }
    let externalIp: string | null = null;
    try {
      const res = await natPmpRequest(gateway, Buffer.from([0, 0]), port, this.timeoutMs);
      if (res.length >= 12) externalIp = [...res.subarray(8, 12)].join('.');
    } catch {
      /* optional */
    }
    return { method: 'nat-pmp', externalIp, mappings };
  }

  /** Asks the router for its internet address without opening anything (for manual port forwarding). */
  async lookupExternalIp(): Promise<string | null> {
    try {
      const ip = tag(await soap(await this.findIgd(), 'GetExternalIPAddress', [], this.timeoutMs), 'NewExternalIPAddress');
      if (ip && net.isIPv4(ip)) return ip;
    } catch {
      /* try NAT-PMP */
    }
    if (!this.opts.gateway) return null;
    try {
      const res = await natPmpRequest(this.opts.gateway, Buffer.from([0, 0]), this.opts.natPmpPort ?? 5351, this.timeoutMs);
      return res.length >= 12 ? [...res.subarray(8, 12)].join('.') : null;
    } catch {
      return null;
    }
  }

  /** Removes the mappings from the router (best effort, bounded in time). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    const current = this.current;
    this.current = null;
    if (!current) return;
    const timeoutMs = Math.min(this.timeoutMs, 1500);
    await Promise.all(
      current.mappings.map(async (m) => {
        try {
          if (current.method === 'upnp' && this.igd) {
            await soap(this.igd, 'DeletePortMapping', [['NewRemoteHost', ''], ['NewExternalPort', m.externalPort], ['NewProtocol', m.protocol]], timeoutMs);
          } else if (current.method === 'nat-pmp' && this.opts.gateway) {
            const msg = Buffer.alloc(12);
            msg[1] = m.protocol === 'UDP' ? 1 : 2;
            msg.writeUInt16BE(m.internalPort, 4);
            await natPmpRequest(this.opts.gateway, msg, this.opts.natPmpPort ?? 5351, timeoutMs);
          }
        } catch {
          /* the lease runs out on its own */
        }
      }),
    );
  }
}
