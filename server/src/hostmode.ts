/**
 * Host mode: this computer is the BeamDesk server. One call starts everything another device
 * needs, on one port number (TCP and UDP), with nothing outside this computer and its router:
 *
 *  - the signaling server over HTTPS/WSS (TLS 1.3, self-signed certificate pinned by the code),
 *  - a STUN/TURN relay for networks where devices cannot reach each other directly,
 *  - optionally the router's port forwarding (UPnP / NAT-PMP), renewed while it runs,
 *  - optionally the beacon: reachable through public Nostr relays when nothing else works
 *    (carrier-grade NAT, no port forwarding), end-to-end encrypted (packages/core/src/beacon.ts),
 *  - a connection code with the addresses, the certificate fingerprint, the access key and the
 *    beacon key.
 */
import crypto from 'node:crypto';
import tls from 'node:tls';
import { encodeJoinCode, type HomeAddress } from '@beamdesk/core/joincode';
import { BeaconServer, beaconKeypair, beaconPublicKey, DEFAULT_RELAYS } from '@beamdesk/core/beacon';
import { fromBase64Url, toBase64Url } from '@beamdesk/core/util';
import type { HostModeStatus } from '@beamdesk/core/bridge';
import { certificateValid, createHostCertificate, fingerprintOf } from './cert.ts';
import { loadConfig } from './config.ts';
import { classifyIPv4, defaultGateway, localAddresses, primaryAddress, type LocalAddresses } from './netinfo.ts';
import { PortMapper, type PortMapperOptions, type PortMapResult } from './portmap.ts';
import { createBeamServer, type BeamServer } from './server.ts';
import type { SelfIce } from './ice.ts';
import { createTurnServer, type TurnServer } from './turn.ts';

export const DEFAULT_HOST_PORT = 41443;

/**
 * Public STUN servers, used only with the beacon: devices behind carrier-grade NAT learn their
 * public address from them so they can connect directly (these servers only see IP addresses).
 */
export const DEFAULT_PUBLIC_STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];

export interface HostSecrets {
  /** PEM private key and certificate of the server. */
  key: string;
  cert: string;
  /** base64url, 16 bytes: devices need it to register. */
  accessKey: string;
  /** Secret of the relay's short-lived credentials. */
  turnSecret: string;
  /** X25519 secret key of the beacon (base64url); its public key is in the connection code. */
  beaconKey?: string;
}

export function createHostSecrets(): HostSecrets {
  const { key, cert } = createHostCertificate();
  return {
    key,
    cert,
    accessKey: crypto.randomBytes(16).toString('base64url'),
    turnSecret: crypto.randomBytes(32).toString('base64url'),
    beaconKey: toBase64Url(beaconKeypair().secret),
  };
}

/** Secrets from 1.1 have no beacon key yet: adds one (the caller stores the result). */
export function withBeaconKey(s: HostSecrets): HostSecrets {
  return s.beaconKey ? s : { ...s, beaconKey: toBase64Url(beaconKeypair().secret) };
}

/** True if stored secrets are complete and belong together. */
export function hostSecretsValid(s: Partial<HostSecrets> | null | undefined): s is HostSecrets {
  return (
    !!s &&
    typeof s.key === 'string' &&
    typeof s.cert === 'string' &&
    typeof s.accessKey === 'string' &&
    /^[A-Za-z0-9_-]{22}$/.test(s.accessKey) &&
    typeof s.turnSecret === 'string' &&
    s.turnSecret.length >= 32 &&
    (s.beaconKey === undefined || (typeof s.beaconKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s.beaconKey))) &&
    certificateValid({ key: s.key, cert: s.cert })
  );
}

export interface HostModeOptions {
  port: number;
  dataDir: string;
  webRoot: string | null;
  /** Server name shown to joining devices. */
  name: string;
  secrets: HostSecrets;
  /** Ask the router to forward the port (UPnP / NAT-PMP). */
  portMapping: boolean;
  /** A DNS name (or fixed address) that reaches this computer, e.g. from a dynamic DNS service. */
  publicHost?: string;
  /** Reachable through public relays ([] = the default relays); null or absent: off. */
  beacon?: { relays: string[] } | null;
  /** STUN servers handed to devices while the beacon is on (default DEFAULT_PUBLIC_STUN). */
  publicStun?: string[];
  log?: (msg: string) => void;
  /** Tests. */
  portMapper?: Partial<PortMapperOptions>;
  networkCheckMs?: number;
}

export type { HostModeStatus };

export interface HostMode {
  status(): HostModeStatus;
  onStatus(cb: (s: HostModeStatus) => void): () => void;
  /** Look at the network again (new address, router changed), e.g. after waking from sleep. */
  refresh(): Promise<void>;
  stop(): Promise<void>;
}

/** Tries a TLS connection and checks that the answer is this server (by its certificate). */
export function probeServer(host: string, port: number, fingerprint: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1.3', servername: undefined, timeout: timeoutMs });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate()?.raw;
      done(!!raw && fingerprintOf(raw) === fingerprint);
    });
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const sameNet = (a: LocalAddresses, b: LocalAddresses) => a.lan[0] === b.lan[0] && a.tailscale[0] === b.tailscale[0] && a.public[0] === b.public[0];

export async function startHostMode(opts: HostModeOptions): Promise<HostMode> {
  const log = opts.log ?? (() => undefined);
  if (!hostSecretsValid(opts.secrets)) throw new Error('Host mode secrets are missing or damaged.');
  const { secrets, port } = opts;
  const beaconOn = !!opts.beacon && !!secrets.beaconKey;
  const customRelays = opts.beacon?.relays.slice(0, 4) ?? [];
  const fingerprint = fingerprintOf(secrets.cert);
  const publicHost = opts.publicHost?.trim().toLowerCase() || null;

  let primary = await primaryAddress();
  let addrs = localAddresses(primary);
  /** Where relay sockets live: the home network address, so devices meet on this computer. */
  const relayFor = (a: LocalAddresses, p: string | null) => a.lan[0] ?? a.public[0] ?? a.tailscale[0] ?? p ?? '127.0.0.1';
  let relayAddress = relayFor(addrs, primary);
  const internet: HostModeStatus['internet'] = {
    mapping: opts.portMapping ? 'pending' : 'off',
    mappingError: null,
    externalIp: addrs.public[0] ?? null,
    externalPort: port,
    behindCgnat: false,
    reachable: 'unknown',
  };
  let externalUdpPort = port;
  let stopped = false;
  const listeners = new Set<(s: HostModeStatus) => void>();

  const config = loadConfig({
    PORT: String(port),
    HOST: '0.0.0.0',
    // What anyone scanning the port may see: nothing personal (the code carries the real name).
    SERVER_NAME: 'BeamDesk',
    DATA_DIR: opts.dataDir,
    WEB_ROOT: opts.webRoot ?? '',
    ACCESS_KEY: secrets.accessKey,
    // Without the beacon no outside STUN server is needed: the built-in one answers.
    STUN_URLS: beaconOn ? (opts.publicStun ?? DEFAULT_PUBLIC_STUN).join(',') : '',
    TURN_TTL: '3600',
    // A home server serves one household: small limits make abuse pointless.
    MAX_CLIENTS: '256',
    MAX_CONNECTIONS_PER_IP: '16',
    NEW_DEVICES_PER_HOUR: '30',
    NEW_DEVICES_GLOBAL_PER_HOUR: '120',
    MAX_DEVICES: '2000',
  });

  /** The relay address a client should use, given the address it reached us on. */
  const endpointFor = (requestHost: string | null): { host: string; port: number } => {
    const own = [...addrs.lan, ...addrs.tailscale, ...addrs.public, relayAddress];
    if (requestHost && own.includes(requestHost)) return { host: requestHost, port };
    if (!requestHost || requestHost === 'localhost' || classifyIPv4(requestHost) === 'loopback') return { host: relayAddress, port };
    // Reached over the internet (the router's address, a DNS name, or IPv6).
    if (requestHost.includes(':')) return { host: internet.externalIp ?? relayAddress, port: externalUdpPort };
    return { host: requestHost, port: externalUdpPort };
  };

  /** A household's worth of relayed sessions, each capped, so nobody can fill the home connection. */
  const relayLimits = { maxAllocations: 32, maxAllocationsPerUser: 4, bandwidthPerAllocation: 4 * 1024 * 1024 };
  let turn: TurnServer = createTurnServer({ port, secret: secrets.turnSecret, relayAddress, ...relayLimits });
  await turn.listen().catch((err: Error) => {
    throw new Error(portError(err, port, 'UDP'));
  });
  const beam: BeamServer = createBeamServer(config, {
    tls: { key: secrets.key, cert: secrets.cert },
    selfIce: { secret: secrets.turnSecret, endpointFor },
    maxConnections: 512,
    perIpConnections: { concurrent: 32, perSecond: 5, burst: 40 },
  });
  try {
    await beam.listen();
  } catch (err) {
    await turn.close();
    throw new Error(portError(err as Error, port, 'TCP'));
  }
  log(`host mode: listening on port ${port} (TCP+UDP), relay on ${relayAddress}`);

  let mapper: PortMapper | null = null;

  /** Where this server can be reached directly right now. */
  const currentAddresses = (): HomeAddress[] => {
    const addresses: HomeAddress[] = [];
    for (const ip of addrs.lan.slice(0, 2)) addresses.push({ kind: 'lan', host: ip, port });
    for (const ip of addrs.tailscale.slice(0, 1)) addresses.push({ kind: 'tailscale', host: ip, port });
    if (internet.externalIp && classifyIPv4(internet.externalIp) === 'public') addresses.push({ kind: 'internet', host: internet.externalIp, port: internet.externalPort });
    if (publicHost) addresses.push({ kind: 'name', host: publicHost, port: internet.externalPort });
    if (!addresses.length) addresses.push({ kind: 'lan', host: relayAddress, port });
    return addresses;
  };

  /** The built-in relay for devices coming through the beacon: only if the internet can reach it. */
  const remoteIce = (): SelfIce | null =>
    internet.externalIp && !internet.behindCgnat && (internet.reachable === 'yes' || internet.mapping === 'upnp' || internet.mapping === 'nat-pmp')
      ? { host: internet.externalIp, port: externalUdpPort, secret: secrets.turnSecret }
      : null;

  const beaconPub = beaconOn ? toBase64Url(beaconPublicKey(fromBase64Url(secrets.beaconKey!))) : null;
  let beacon: BeaconServer | null = null;
  if (beaconOn) {
    beacon = new BeaconServer({
      secret: fromBase64Url(secrets.beaconKey!),
      psk: fromBase64Url(secrets.accessKey),
      relays: customRelays.length ? customRelays : DEFAULT_RELAYS,
      info: () => ({ name: opts.name, addresses: currentAddresses() }),
      onConnection: (c) => beam.attach(c, { key: `beacon:${c.id}`, selfIce: remoteIce() }),
      onStatus: () => emit(),
    });
    beacon.start();
  }

  const status = (): HostModeStatus => {
    const addresses = currentAddresses();
    const code = encodeJoinCode({ name: opts.name, fingerprint, accessKey: secrets.accessKey, addresses, beacon: beaconPub ? { key: beaconPub, relays: customRelays } : undefined });
    const b = beacon?.status();
    return {
      state: stopped ? 'stopped' : 'running',
      port,
      fingerprint,
      lan: addrs.lan[0] ?? null,
      tailscale: addrs.tailscale[0] ?? null,
      internet: { ...internet },
      publicHost,
      code,
      browserUrls: addresses.map((a) => `https://${a.host}:${a.port}`),
      devices: beam.stats().registered,
      beacon: { enabled: beaconOn, relays: b?.relays ?? 0, total: b?.total ?? 0, clients: b?.clients ?? 0 },
    };
  };

  const emit = () => {
    if (stopped) return;
    const s = status();
    for (const cb of listeners) cb(s);
  };

  const applyMapping = (r: PortMapResult | null) => {
    if (!r) return;
    internet.mapping = r.method;
    internet.mappingError = null;
    internet.externalIp = r.externalIp ?? internet.externalIp;
    internet.externalPort = r.mappings.find((m) => m.protocol === 'TCP')?.externalPort ?? port;
    externalUdpPort = r.mappings.find((m) => m.protocol === 'UDP')?.externalPort ?? port;
  };

  async function checkInternet(): Promise<void> {
    const gateway = addrs.lan[0] ? await defaultGateway(addrs.lan[0]) : null;
    const mapperOpts: PortMapperOptions = {
      internalAddress: relayAddress,
      ports: [
        { protocol: 'TCP', port },
        { protocol: 'UDP', port },
      ],
      gateway,
      description: 'BeamDesk host mode',
      onChange: (r, error) => {
        if (error) {
          internet.mappingError = error;
          log(`host mode: port mapping renewal failed: ${error}`);
        } else applyMapping(r);
        emit();
      },
      ...opts.portMapper,
    };
    await mapper?.stop();
    mapper = null;
    if (addrs.public.length) {
      // Directly on the internet: nothing to open on a router.
      internet.externalIp = addrs.public[0];
      internet.mapping = 'off';
    } else if (opts.portMapping && addrs.lan.length) {
      internet.mapping = 'pending';
      emit();
      lastMappingAttempt = Date.now();
      const m = new PortMapper(mapperOpts);
      mapper = m;
      try {
        applyMapping(await m.start());
        if (stopped) return void (await m.stop());
        log(`host mode: router forwards port ${port} (${internet.mapping}), internet address ${internet.externalIp ?? 'unknown'}`);
      } catch (err) {
        mapper = null;
        internet.mapping = 'failed';
        internet.mappingError = (err as Error).message;
        log(`host mode: could not open the port on the router: ${internet.mappingError}`);
        internet.externalIp = (await new PortMapper(mapperOpts).lookupExternalIp()) ?? internet.externalIp;
      }
    } else if (addrs.lan.length) {
      // Port forwarded by hand (or not at all): still learn the router's address, read-only.
      internet.externalIp = (await new PortMapper(mapperOpts).lookupExternalIp()) ?? null;
    }
    if (stopped) return;
    internet.behindCgnat = !!internet.externalIp && classifyIPv4(internet.externalIp) !== 'public';
    internet.reachable = 'checking';
    emit();
    const target = internet.externalIp && !internet.behindCgnat ? internet.externalIp : publicHost;
    internet.reachable = target && (await probeServer(target, internet.externalPort, fingerprint)) ? 'yes' : 'unknown';
    emit();
  }

  let lastMappingAttempt = 0;
  let refreshing: Promise<void> | null = null;
  async function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      primary = await primaryAddress();
      const next = localAddresses(primary);
      const nextRelay = relayFor(next, primary);
      const changed = !sameNet(next, addrs);
      addrs = next;
      if (nextRelay !== relayAddress && !stopped) {
        log(`host mode: network changed, relay moves to ${nextRelay}`);
        relayAddress = nextRelay;
        await turn.close();
        turn = createTurnServer({ port, secret: secrets.turnSecret, relayAddress, ...relayLimits });
        await turn.listen().catch((err: Error) => log(`host mode: relay restart failed: ${err.message}`));
      }
      // A router that refused stays asked every few minutes (it may have been rebooted or reconfigured).
      const retry = internet.mapping === 'failed' && Date.now() - lastMappingAttempt > 5 * 60_000;
      if (changed || retry) await checkInternet();
      emit();
    })().finally(() => (refreshing = null));
    return refreshing;
  }

  void checkInternet().catch((err) => log(`host mode: ${(err as Error).message}`));

  // Laptops move between networks and routers hand out new addresses: keep looking.
  const watcher = setInterval(() => void refresh().catch(() => undefined), opts.networkCheckMs ?? 60_000);
  watcher.unref();
  // The number of devices shown in the app.
  let lastDevices = 0;
  const counter = setInterval(() => {
    const n = beam.stats().registered;
    if (n !== lastDevices) {
      lastDevices = n;
      emit();
    }
  }, 5000);
  counter.unref();

  return {
    status,
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    refresh,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(watcher);
      clearInterval(counter);
      beacon?.stop();
      await Promise.allSettled([mapper?.stop(), beam.close(), turn.close()]);
      log('host mode: stopped');
    },
  };
}

function portError(err: Error, port: number, proto: string): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') return `Port ${port} (${proto}) is already used by another program. Choose another port in Advanced.`;
  if (code === 'EACCES') return `This computer does not allow BeamDesk to use port ${port} (${proto}). Choose a port above 1024.`;
  return `Could not open port ${port} (${proto}): ${err.message}`;
}
