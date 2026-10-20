/**
 * Host mode in the desktop app: this computer runs the BeamDesk server (server/src/hostmode.ts).
 *
 *  - It comes back on its own after a restart: the setting is remembered, BeamDesk starts at
 *    login and turns the server on again.
 *  - While it serves, the computer is kept from sleeping (optional).
 *  - Home servers use self-signed certificates: the app accepts a server's certificate only if its
 *    fingerprint matches the connection code (pinning, see pinnedsocket.ts), for this computer's
 *    own server and for the one this device joined.
 */
import { app, powerMonitor, powerSaveBlocker } from 'electron';
import path from 'node:path';
import { createHostSecrets, DEFAULT_HOST_PORT, hostSecretsValid, startHostMode, type HostMode, type HostSecrets } from '@beamdesk/server/hostmode';
import { fingerprintOf } from '@beamdesk/server/cert';
import { decodeJoinCode, homeServerHosts } from '@beamdesk/core/joincode';
import type { HostModeConfig, HostModeInfo } from '@beamdesk/core/bridge';
import type { SettingsStore } from './store.ts';

const DNS_OR_IP = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const DEFAULTS: HostModeConfig = { enabled: false, portMapping: true, keepAwake: true, port: DEFAULT_HOST_PORT, publicHost: '' };

/** Accepts only well-formed values; anything else keeps the current one. */
export function sanitizeHostConfig(current: HostModeConfig, patch: unknown): HostModeConfig {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const next = { ...current };
  if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
  if (typeof p.portMapping === 'boolean') next.portMapping = p.portMapping;
  if (typeof p.keepAwake === 'boolean') next.keepAwake = p.keepAwake;
  if (Number.isInteger(p.port) && (p.port as number) >= 1024 && (p.port as number) <= 65535) next.port = p.port as number;
  if (typeof p.publicHost === 'string' && (p.publicHost === '' || DNS_OR_IP.test(p.publicHost.trim()))) next.publicHost = p.publicHost.trim().toLowerCase();
  return next;
}

export class HostServer {
  private readonly store: SettingsStore;
  private readonly webRoot: string;
  private readonly notify: (info: HostModeInfo) => void;
  private mode: HostMode | null = null;
  private phase: HostModeInfo['phase'] = 'off';
  private error: string | null = null;
  private blocker: number | null = null;
  /** Serializes start/stop so quick toggles cannot overlap. */
  private queue: Promise<unknown> = Promise.resolve();
  private pins = new Map<string, string>();

  constructor(opts: { store: SettingsStore; webRoot: string; onChange: (info: HostModeInfo) => void }) {
    this.store = opts.store;
    this.webRoot = opts.webRoot;
    this.notify = opts.onChange;
  }

  get config(): HostModeConfig {
    return sanitizeHostConfig(DEFAULTS, this.store.get('hostMode'));
  }

  info(): HostModeInfo {
    const status = this.mode?.status() ?? null;
    return {
      config: this.config,
      phase: this.phase,
      error: this.error,
      localUrl: this.phase === 'off' ? null : `wss://127.0.0.1:${this.config.port}/ws`,
      accessKey: this.phase === 'off' ? null : (this.secrets()?.accessKey ?? null),
      status,
    };
  }

  /** Called once at startup: pins certificates and turns the server back on if it was on. */
  init(): void {
    this.updatePins();
    powerMonitor.on('resume', () => void this.mode?.refresh());
    if (this.config.enabled) void this.enqueue(() => this.start());
  }

  set(patch: unknown): Promise<HostModeInfo> {
    return this.enqueue(async () => {
      const before = this.config;
      const next = sanitizeHostConfig(before, patch);
      this.store.set('hostMode', next);
      const restart = before.port !== next.port || before.portMapping !== next.portMapping || before.publicHost !== next.publicHost;
      if (!next.enabled) await this.stop();
      else if (!this.mode || restart || this.phase === 'error') {
        await this.stop();
        await this.start();
      } else this.keepAwake();
      return this.info();
    });
  }

  /** New certificate and access key: every device that joined has to use the new code. */
  regenerate(): Promise<HostModeInfo> {
    return this.enqueue(async () => {
      this.store.setSecret('hostSecrets', JSON.stringify(createHostSecrets()));
      if (this.mode) {
        await this.stop();
        await this.start();
      }
      return this.info();
    });
  }

  refresh(): void {
    void this.mode?.refresh();
  }

  /** Stops the server and removes the router's port forwarding (bounded in time). */
  async shutdown(): Promise<void> {
    await Promise.race([this.enqueue(() => this.stop()), new Promise((r) => setTimeout(r, 3000))]);
  }

  /** The certificate fingerprint a host must present: the joined home server's, or this computer's own. */
  pinFor(host: string): string | null {
    return this.pins.get(host) ?? null;
  }

  /** Rebuilds the pins from the stored code and the running server (called when either changes). */
  updatePins(): void {
    const pins = new Map<string, string>();
    const joined = decodeJoinCode(this.store.getSecret('homeServer') ?? '');
    if (joined) for (const h of homeServerHosts(joined)) pins.set(h, joined.fingerprint);
    // This computer's own server wins for its own addresses.
    const own = this.secrets();
    if (own && this.mode) {
      const fp = fingerprintOf(own.cert);
      const s = this.mode.status();
      for (const h of ['127.0.0.1', s.lan, s.tailscale, s.internet.externalIp, s.publicHost]) if (h) pins.set(h.toLowerCase(), fp);
    }
    this.pins = pins;
  }

  private cached: { raw: string; secrets: HostSecrets } | null = null;

  private secrets(): HostSecrets | null {
    const raw = this.store.getSecret('hostSecrets');
    if (!raw) return null;
    if (this.cached?.raw === raw) return this.cached.secrets;
    try {
      const parsed = JSON.parse(raw);
      if (!hostSecretsValid(parsed)) return null;
      this.cached = { raw, secrets: parsed };
      return parsed;
    } catch {
      return null;
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private changed(): void {
    this.updatePins();
    this.notify(this.info());
  }

  private async start(): Promise<void> {
    let secrets = this.secrets();
    if (!secrets) {
      secrets = createHostSecrets();
      this.store.setSecret('hostSecrets', JSON.stringify(secrets));
    }
    const cfg = this.config;
    this.phase = 'starting';
    this.error = null;
    this.changed();
    const name = String((this.store.get<Record<string, unknown>>('settings')?.deviceName as string) || 'BeamDesk home server').slice(0, 48);
    try {
      this.mode = await startHostMode({
        port: cfg.port,
        dataDir: path.join(app.getPath('userData'), 'host-server'),
        webRoot: this.webRoot,
        name,
        secrets,
        portMapping: cfg.portMapping,
        publicHost: cfg.publicHost || undefined,
        log: (m) => console.log(`[host] ${m}`),
      });
      this.phase = 'running';
      this.mode.onStatus(() => this.changed());
    } catch (err) {
      this.mode = null;
      this.phase = 'error';
      this.error = (err as Error).message;
      console.error('[host] could not start', this.error);
    }
    this.keepAwake();
    this.changed();
  }

  private async stop(): Promise<void> {
    const mode = this.mode;
    this.mode = null;
    this.phase = 'off';
    this.error = null;
    this.keepAwake();
    if (mode) await mode.stop();
    this.changed();
  }

  private keepAwake(): void {
    const want = this.phase === 'running' && this.config.keepAwake;
    if (want && this.blocker === null) this.blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!want && this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker);
      this.blocker = null;
    }
  }
}
