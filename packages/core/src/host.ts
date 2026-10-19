/**
 * Host side: receives incoming connection requests, authenticates them, asks the user
 * (if needed), shares the screen and applies remote input through the platform adapter.
 */
import {
  confirmationTag,
  cpaceFinish,
  cpaceStart,
  PASSWORD_SLOTS,
  securityCode,
  verifyConfirmation,
  type CpaceState,
  type PasswordSlot,
} from './cpace.ts';
import { Identity, keyHash, publicKeyMatchesId, verifySignature } from './identity.ts';
import {
  acceptTranscript,
  APP_VERSION,
  decodePointerMove,
  hostTranscript,
  parseControlMessage,
  PROTOCOL_VERSION,
  sanitizeName,
  seqNewer,
  viewerTranscript,
  type AnswerData,
  type AuthFailure,
  type AuthResult,
  type ControlMessage,
  type DisplayInfo,
  type HostCapabilities,
  type HostHello,
  type OfferData,
  type Permissions,
  type Platform,
  type QualitySettings,
  type ViewerAuth,
  VIEW_ONLY_PERMISSIONS,
} from './protocol.ts';
import { CandidateGate, createPeer, sendControl, type PeerChannels } from './peer.ts';
import { addBitrateHints, channelIdentifier, fingerprintKey, orderCodecs, splitCandidates, type CodecPreference } from './sdp.ts';
import { chooseCodecs, planQuality } from './quality.ts';
import { FileTransfers, type FileSinkFactory, type Transfer } from './files.ts';
import { codeToKey } from './keymap.ts';
import type { IncomingSignal, SignalingClient } from './signaling.ts';
import { Emitter, fromBase64Url, toBase64Url, utf8 } from './util.ts';
import type { ChatMessage } from './viewer.ts';

export type InputCommand =
  | { k: 'move'; x: number; y: number }
  | { k: 'button'; button: 'left' | 'middle' | 'right'; down: boolean; x: number; y: number }
  | { k: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { k: 'key'; key: string; down: boolean }
  | { k: 'text'; text: string }
  | { k: 'combo'; keys: string[] }
  | { k: 'release' };

/** What the host device can do. Implemented by the desktop app (Electron) and the browser. */
export interface HostPlatform {
  kind: 'desktop' | 'web';
  capabilities(): HostCapabilities;
  listDisplays(): Promise<DisplayInfo[]>;
  /** Starts capturing a display (null = default). May show a picker in browsers. */
  capture(displayId: string | null, opts: { fps: number; audio: boolean }): Promise<{ stream: MediaStream; displayId: string }>;
  input?(displayId: string, cmd: InputCommand): void;
  writeClipboard?(text: string): Promise<void>;
  watchClipboard?(cb: (text: string) => void): () => void;
  fileSink: FileSinkFactory;
}

export interface HostSettings {
  /** 'ask': prompt or password, 'password': password only, 'off': no incoming sessions. */
  access: 'ask' | 'password' | 'off';
  /** Offer the rotating one-time password. */
  oneTimePassword: boolean;
  /** Still show the accept prompt when the one-time password is correct. */
  askEvenWithPassword: boolean;
  /** Unattended access with the permanent password. */
  unattended: boolean;
  /** Devices marked as trusted connect without a prompt. */
  trustedAutoAccept: boolean;
  forceRelay: boolean;
  maxSessions: number;
  defaultPerms: Permissions;
  quality: QualitySettings;
  codec: CodecPreference;
  shareAudio: boolean;
}

export interface HostSecrets {
  otp: Uint8Array | null;
  perm: Uint8Array | null;
}

export interface TrustStore {
  isTrusted(id: string, publicKey: string): boolean;
  isBlocked(id: string): boolean;
  trust(id: string, publicKey: string, name: string): void;
  block(id: string, name: string): void;
}

export interface IncomingRequest {
  sid: string;
  viewerId: string;
  name: string;
  platform: Platform;
  securityCode: string;
  /** The viewer's key matches a device seen before. */
  knownDevice: boolean;
  expiresAt: number;
  accept(perms: Permissions, opts?: { trust?: boolean }): void;
  decline(opts?: { block?: boolean }): void;
}

export interface HostServiceOptions {
  signaling: SignalingClient;
  identity: Identity;
  platform: HostPlatform;
  settings: HostSettings;
  secrets: HostSecrets;
  trust: TrustStore;
  deviceName: string;
  devicePlatform: Platform;
}

type ServiceEvents = {
  request: IncomingRequest;
  'request-closed': string;
  sessions: HostSession[];
  'otp-used': void;
  'auth-failure': { viewerId: string; reason: AuthFailure };
};

const PROMPT_TIMEOUT = 60_000;
const MAX_PENDING = 6;
const MAX_FAILURES = 5;
const FAILURE_WINDOW = 10 * 60_000;
const LOCK_TIME = 5 * 60_000;

export class HostService extends Emitter<ServiceEvents> {
  readonly sessions = new Map<string, HostSession>();
  private failures: number[] = [];
  private lockedUntil = 0;
  private declined = new Map<string, number>();
  private preapproved = new Map<string, { keyHash: string; perms: Permissions; until: number }>();
  private off: (() => void) | null = null;

  readonly opts: HostServiceOptions;

  constructor(opts: HostServiceOptions) {
    super();
    this.opts = opts;
  }

  start(): void {
    this.off ??= this.opts.signaling.on('signal', (s) => this.onSignal(s));
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.endAll('local');
  }

  update(patch: Partial<Pick<HostServiceOptions, 'settings' | 'secrets' | 'deviceName'>>): void {
    Object.assign(this.opts, patch);
  }

  /** Sessions that are live (accepted). */
  active(): HostSession[] {
    return [...this.sessions.values()].filter((s) => s.phase === 'active');
  }

  endAll(reason = 'local'): void {
    for (const s of [...this.sessions.values()]) s.close(reason);
  }

  /**
   * Lets one specific device in without a prompt, once, for a limited time (help links).
   * Bound to the device's key hash: a 9-digit ID alone is too short to trust.
   */
  preapprove(viewerId: string, viewerKeyHash: string, perms: Permissions, ttlMs = 10 * 60_000): void {
    this.preapproved.set(viewerId, { keyHash: viewerKeyHash, perms, until: Date.now() + ttlMs });
  }

  isLocked(): boolean {
    return Date.now() < this.lockedUntil;
  }

  /** @internal */
  takePreapproval(viewerId: string, viewerKey: string): Permissions | null {
    const p = this.preapproved.get(viewerId);
    if (!p || p.keyHash !== keyHash(viewerKey)) return null;
    this.preapproved.delete(viewerId);
    return p.until > Date.now() ? p.perms : null;
  }

  /** @internal */
  recordFailure(viewerId: string, reason: AuthFailure): void {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW);
    this.failures.push(now);
    if (this.failures.length >= MAX_FAILURES) {
      this.lockedUntil = now + LOCK_TIME;
      this.failures = [];
    }
    this.emit('auth-failure', { viewerId, reason });
  }

  /** @internal */
  recordDecline(viewerId: string): void {
    this.declined.set(viewerId, Date.now() + 30_000);
  }

  /** @internal */
  emitRequest(r: IncomingRequest): void {
    this.emit('request', r);
  }

  /** @internal */
  sessionChanged(s: HostSession): void {
    // A prompt is resolved as soon as the session leaves the prompting phase.
    if (s.wasPrompting && s.phase !== 'prompting') this.emit('request-closed', s.sid);
    if (s.phase === 'closed') {
      this.sessions.delete(s.sid);
      if (s.authorizedBy === 'otp') this.emit('otp-used', undefined);
    }
    this.emit('sessions', this.active());
  }

  private onSignal(s: IncomingSignal): void {
    const existing = this.sessions.get(s.sid);
    if (existing) {
      if (existing.viewerId === s.from) void existing.onSignal(s);
      return;
    }
    if (s.kind !== 'offer' || (s.data as OfferData)?.restart) return;
    const reject = (reason: AuthFailure) => this.opts.signaling.send(s.from, s.sid, 'auth-result', { ok: false, reason } satisfies AuthResult);

    if (this.opts.settings.access === 'off') return void reject('not-accepting');
    if (this.opts.trust.isBlocked(s.from)) return void reject('blocked');
    if ((this.declined.get(s.from) ?? 0) > Date.now()) return void reject('declined');
    const live = [...this.sessions.values()].filter((x) => x.phase !== 'closed');
    const pending = live.filter((x) => x.phase !== 'active');
    // Only accepted sessions count toward the limit, so unauthenticated requests cannot block it.
    if (live.length - pending.length >= Math.max(1, this.opts.settings.maxSessions)) return void reject('busy');
    if (pending.length >= MAX_PENDING || pending.some((x) => x.viewerId === s.from)) return void reject('busy');

    const session = new HostSession(this, s.from, s.sid);
    this.sessions.set(s.sid, session);
    void session.start(s.data as OfferData);
  }
}

export type HostPhase = 'negotiating' | 'authenticating' | 'prompting' | 'active' | 'closed';

type SessionEvents = {
  phase: HostPhase;
  perms: Permissions;
  chat: ChatMessage;
  transfers: Transfer[];
  'file-received': Transfer;
  display: string;
  closed: { reason: string };
};

export class HostSession extends Emitter<SessionEvents> {
  phase: HostPhase = 'negotiating';
  viewerName = 'Unknown device';
  viewerPlatform: Platform = 'unknown';
  viewerKey = '';
  perms: Permissions;
  displayId = '';
  displays: DisplayInfo[] = [];
  chat: ChatMessage[] = [];
  startedAt = 0;
  authorizedBy: PasswordSlot | 'approval' | 'trusted' | 'invite' | null = null;
  wasPrompting = false;
  securityCode = '';
  readonly files: FileTransfers;

  private pc: RTCPeerConnection | null = null;
  private channels: PeerChannels | null = null;
  private gate: CandidateGate | null = null;
  private videoTx: RTCRtpTransceiver | null = null;
  private audioTx: RTCRtpTransceiver | null = null;
  private stream: MediaStream | null = null;
  private ci = '';
  private cpace: Partial<Record<PasswordSlot, CpaceState>> = {};
  private isk: Uint8Array | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private lastSeq = -1;
  private lastClipboard = '';
  private unwatchClipboard: (() => void) | null = null;
  private quality: QualitySettings;
  private captureWidth = 1920;
  private switching: Promise<void> = Promise.resolve();
  private encoding: Promise<void> = Promise.resolve();
  /** Candidates that arrive while the peer connection is still being created. */
  private earlyIce: RTCIceCandidateInit[] = [];
  /** The viewer's DTLS certificate, pinned for ICE restarts. */
  private remoteFingerprints = '';

  private readonly service: HostService;
  readonly viewerId: string;
  readonly sid: string;

  constructor(service: HostService, viewerId: string, sid: string) {
    super();
    this.service = service;
    this.viewerId = viewerId;
    this.sid = sid;
    const o = service.opts;
    // No permissions at all until the session is accepted.
    this.perms = { ...VIEW_ONLY_PERMISSIONS };
    this.quality = { ...o.settings.quality };
    this.files = new FileTransfers(o.platform.fileSink, () => this.phase === 'active' && this.perms.files && o.platform.capabilities().files);
    this.files.on('update', (l) => this.emit('transfers', l));
    this.files.on('received', (t) => this.emit('file-received', t));
  }

  private get o(): HostServiceOptions {
    return this.service.opts;
  }

  async start(offer: OfferData): Promise<void> {
    try {
      if (!offer || typeof offer.sdp !== 'string' || offer.sdp.length > 40_000) return this.reject('unsupported');
      this.viewerName = sanitizeName(offer.name);
      this.viewerPlatform = (offer.platform as Platform) || 'unknown';
      const ice = await this.o.signaling.refreshIce();
      if (this.phase === 'closed') return;

      const { pc, channels } = createPeer(ice, this.o.settings.forceRelay);
      this.pc = pc;
      this.channels = channels;
      const gate = new CandidateGate(pc, (c) => this.signal('ice', c));
      this.gate = gate;
      pc.onicecandidate = (e) => gate.onLocal(e.candidate);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' && this.phase === 'active') {
          // The viewer drives ICE restarts; give it time before giving up.
          this.after(45_000, () => {
            if (this.pc?.connectionState === 'failed') this.close('connection-failed');
          });
        }
      };
      channels.control.onopen = () => this.onControlOpen();
      channels.control.onmessage = (e) => this.onControl(e.data);
      channels.control.onclose = () => this.close('remote-closed', false);
      channels.pointer.onmessage = (e) => this.onPointer(e.data);
      this.files.attach(channels.files);

      // Candidates inlined in the SDP must pass the same gate as trickled ones.
      const { sdp: clean, candidates } = splitCandidates(offer.sdp);
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: addBitrateHints(clean, 2500) });
      } catch {
        await pc.setRemoteDescription({ type: 'offer', sdp: clean });
      }
      this.remoteFingerprints = fingerprintKey(clean);
      for (const c of [...candidates, ...this.earlyIce.splice(0)]) await gate.onRemote(c);
      const caps = this.o.platform.capabilities();
      const codecs = await chooseCodecs((offer.prefs?.codec as CodecPreference) ?? this.o.settings.codec);
      for (const t of pc.getTransceivers()) {
        const kind = t.receiver.track.kind;
        if (kind === 'video' && !this.videoTx) {
          t.direction = 'sendonly';
          this.videoTx = t;
          try {
            const rc = RTCRtpReceiver.getCapabilities('video');
            if (rc && codecs.length) t.setCodecPreferences(orderCodecs(rc.codecs, codecs));
          } catch {
            /* keep browser defaults */
          }
        } else if (kind === 'audio' && !this.audioTx) {
          t.direction = caps.audio ? 'sendonly' : 'inactive';
          this.audioTx = t;
        } else {
          t.direction = 'inactive';
        }
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.ci = channelIdentifier(pc.localDescription!.sdp, pc.remoteDescription!.sdp);
      this.securityCode = securityCode(this.ci);

      const shares: HostHello['shares'] = {};
      const { settings, secrets } = this.o;
      const enabled: Record<PasswordSlot, Uint8Array | null> = {
        otp: settings.oneTimePassword ? secrets.otp : null,
        perm: settings.unattended ? secrets.perm : null,
      };
      for (const slot of PASSWORD_SLOTS) {
        const prs = enabled[slot];
        if (!prs) continue;
        const st = cpaceStart(prs, this.ci, this.sid, slot);
        this.cpace[slot] = st;
        shares[slot] = toBase64Url(st.Y);
      }
      const hello: HostHello = {
        v: PROTOCOL_VERSION,
        pk: this.o.identity.publicKeyB64,
        sig: this.o.identity.sign(utf8(hostTranscript(this.sid, this.ci, this.viewerId))),
        name: this.o.deviceName,
        platform: this.o.devicePlatform,
        version: APP_VERSION,
        shares,
        canAsk: settings.access === 'ask',
        caps,
      };
      // Send the answer as created: it contains no ICE candidates (they are gated).
      this.signal('answer', { sdp: answer.sdp!, hello } satisfies AnswerData);
      this.setPhase('authenticating');
      this.after(30_000, () => {
        if (this.phase === 'authenticating') this.close('timeout');
      });
    } catch (err) {
      console.warn('[beamdesk] incoming session failed', err);
      this.close('connection-failed');
    }
  }

  async onSignal(s: IncomingSignal): Promise<void> {
    if (this.phase === 'closed') return;
    switch (s.kind) {
      case 'auth':
        await this.onAuth(s.data as ViewerAuth);
        break;
      case 'ice':
        if (!s.data || typeof s.data !== 'object') break;
        if (this.gate) await this.gate.onRemote(s.data);
        else if (this.earlyIce.length < 64) this.earlyIce.push(s.data);
        break;
      case 'offer': {
        const offer = s.data as OfferData;
        if (!offer?.restart || this.phase !== 'active' || !this.pc || typeof offer.sdp !== 'string' || offer.sdp.length > 40_000) return;
        const { sdp: clean, candidates } = splitCandidates(offer.sdp);
        // An ICE restart must come from the same, authenticated certificate; anything else is
        // an attempt to splice a different DTLS endpoint into the session.
        if (fingerprintKey(clean) !== this.remoteFingerprints) return this.close('bad-identity');
        try {
          await this.pc.setRemoteDescription({ type: 'offer', sdp: clean });
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.signal('answer', { sdp: answer.sdp!, restart: true } satisfies AnswerData);
          await this.gate?.flushRemote();
          for (const c of candidates) await this.gate?.onRemote(c);
        } catch (err) {
          console.warn('[beamdesk] ICE restart answer failed', err);
        }
        break;
      }
      case 'bye':
        this.close(typeof s.data?.reason === 'string' ? s.data.reason : 'remote-closed', false);
        break;
    }
  }

  private async onAuth(a: ViewerAuth): Promise<void> {
    if (this.phase !== 'authenticating' || !a || typeof a !== 'object') return;
    this.setPhase('prompting');
    const me = this.o.identity.id;
    if (
      typeof a.pk !== 'string' ||
      !publicKeyMatchesId(a.pk, this.viewerId) ||
      typeof a.sig !== 'string' ||
      !verifySignature(a.pk, utf8(viewerTranscript(this.sid, this.ci, me)), a.sig)
    ) {
      return this.reject('bad-identity');
    }
    this.viewerKey = a.pk;

    let slot: PasswordSlot | null = null;
    const tried = a.shares && typeof a.shares === 'object' && Object.keys(a.shares).length > 0;
    if (tried) {
      if (this.service.isLocked()) return this.reject('locked');
      for (const s of PASSWORD_SLOTS) {
        const st = this.cpace[s];
        const share = a.shares[s];
        const tag = a.tags?.[s];
        if (!st || typeof share !== 'string' || typeof tag !== 'string') continue;
        try {
          const isk = cpaceFinish(st, fromBase64Url(share), 'host');
          if (verifyConfirmation(isk, 'viewer', this.sid, this.ci, fromBase64Url(tag))) {
            slot = s;
            this.isk = isk;
            break;
          }
        } catch {
          /* malformed share counts as a failure */
        }
      }
      if (!slot) {
        this.service.recordFailure(this.viewerId, 'bad-password');
        return this.reject('bad-password');
      }
    }

    const { settings, trust } = this.o;
    const defaults = { ...settings.defaultPerms };
    if (slot === 'perm') return this.accept(defaults, 'perm');
    if (slot === 'otp' && !settings.askEvenWithPassword) return this.accept(defaults, 'otp');
    const pre = this.service.takePreapproval(this.viewerId, a.pk);
    if (pre) return this.accept(pre, 'invite');
    const known = trust.isTrusted(this.viewerId, a.pk);
    if (!slot && known && settings.trustedAutoAccept) return this.accept(defaults, 'trusted');
    if (!slot && settings.access !== 'ask') return this.reject('password-required');

    // Ask the person in front of the host device.
    this.signal('pending', {});
    this.wasPrompting = true;
    let settled = false;
    const request: IncomingRequest = {
      sid: this.sid,
      viewerId: this.viewerId,
      name: this.viewerName,
      platform: this.viewerPlatform,
      securityCode: this.securityCode,
      knownDevice: known,
      expiresAt: Date.now() + PROMPT_TIMEOUT,
      accept: (perms, opts) => {
        if (settled || this.phase !== 'prompting') return;
        settled = true;
        if (opts?.trust) trust.trust(this.viewerId, this.viewerKey, this.viewerName);
        void this.accept(perms, slot ?? 'approval');
      },
      decline: (opts) => {
        if (settled || this.phase !== 'prompting') return;
        settled = true;
        if (opts?.block) trust.block(this.viewerId, this.viewerName);
        this.service.recordDecline(this.viewerId);
        this.reject('declined');
      },
    };
    this.after(PROMPT_TIMEOUT, () => {
      if (!settled && this.phase === 'prompting') {
        settled = true;
        this.reject('timeout');
      }
    });
    this.service.emitRequest(request);
  }

  private async accept(perms: Permissions, via: NonNullable<HostSession['authorizedBy']>): Promise<void> {
    if (this.phase === 'closed' || !this.pc) return;
    const caps = this.o.platform.capabilities();
    this.perms = {
      control: perms.control && caps.control,
      clipboard: perms.clipboard && caps.clipboard,
      files: perms.files && caps.files,
      audio: perms.audio && caps.audio,
    };
    this.authorizedBy = via;
    this.startedAt = Date.now();
    const slot = via === 'otp' || via === 'perm' ? via : null;
    const tag = slot && this.isk ? toBase64Url(confirmationTag(this.isk, 'host', this.sid, this.ci)) : undefined;
    const sig = this.o.identity.sign(utf8(acceptTranscript(this.sid, this.ci, this.viewerId, slot, this.perms)));
    this.signal('auth-result', { ok: true, slot, tag, perms: this.perms, sig } satisfies AuthResult);
    this.setPhase('active');
    // Do not keep capturing for a viewer whose connection never comes up.
    this.after(45_000, () => {
      if (this.channels?.control.readyState !== 'open') this.close('connection-failed');
    });
    await this.gate?.release();
    try {
      await this.startCapture(null);
    } catch (err) {
      console.warn('[beamdesk] screen capture failed', err);
      sendControl(this.channels?.control, { t: 'notice', level: 'warn', text: 'The other device could not share its screen.' });
      this.close('capture-failed');
    }
  }

  private reject(reason: AuthFailure): void {
    this.signal('auth-result', { ok: false, reason } satisfies AuthResult);
    this.close(reason, false);
  }

  // ------------------------------------------------------------------ screen

  private async startCapture(displayId: string | null): Promise<void> {
    const run = async () => {
      if (this.phase !== 'active' || !this.videoTx) return;
      const platform = this.o.platform;
      this.displays = await platform.listDisplays().catch(() => []);
      const target = displayId ?? (this.displays.find((d) => d.primary) ?? this.displays[0])?.id ?? null;
      const plan = planQuality(this.quality, this.displays.find((d) => d.id === target)?.width ?? 1920);
      const audio = this.perms.audio && this.o.settings.shareAudio && platform.capabilities().audio;
      const { stream, displayId: actual } = await platform.capture(target, { fps: plan.fps, audio });
      if (this.phase !== 'active') {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = stream.getVideoTracks()[0];
      if (!video) throw new Error('no video track');
      try {
        video.contentHint = plan.contentHint;
      } catch {
        /* optional */
      }
      this.captureWidth = video.getSettings().width ?? this.captureWidth;
      await this.videoTx.sender.replaceTrack(video);
      const audioTrack = stream.getAudioTracks()[0] ?? null;
      if (this.audioTx && this.audioTx.direction === 'sendonly') await this.audioTx.sender.replaceTrack(audioTrack);
      const old = this.stream;
      this.stream = stream;
      this.displayId = actual;
      if (old && old !== stream) old.getTracks().forEach((t) => t.stop());
      video.addEventListener('ended', () => {
        // The user pressed the browser's "Stop sharing" button.
        if (this.stream === stream && this.phase === 'active') this.close('capture-ended');
      });
      await this.applyEncoding();
      this.sendDisplays();
      this.emit('display', actual);
    };
    this.switching = this.switching.then(run, run);
    return this.switching;
  }

  /** Serialised: RTCRtpSender.setParameters() rejects overlapping get/set transactions. */
  private applyEncoding(): Promise<void> {
    this.encoding = this.encoding.then(() => this.applyEncodingNow());
    return this.encoding;
  }

  private async applyEncodingNow(): Promise<void> {
    const sender = this.videoTx?.sender;
    if (!sender) return;
    const plan = planQuality(this.quality, this.captureWidth);
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      const e = params.encodings[0] as RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType; priority?: RTCPriorityType };
      e.maxBitrate = plan.maxBitrate;
      e.maxFramerate = plan.fps;
      e.scaleResolutionDownBy = plan.scaleResolutionDownBy;
      e.priority = 'high';
      e.networkPriority = 'high';
      (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = plan.degradationPreference;
      await sender.setParameters(params);
    } catch (err) {
      console.warn('[beamdesk] could not apply encoding parameters', err);
    }
    const track = sender.track;
    if (track) {
      try {
        track.contentHint = plan.contentHint;
      } catch {
        /* optional */
      }
    }
  }

  private sendDisplays(): void {
    sendControl(this.channels?.control, { t: 'displays', list: this.displays, current: this.displayId });
  }

  // ------------------------------------------------------------------ data channels

  private onControlOpen(): void {
    sendControl(this.channels?.control, { t: 'perms', perms: this.perms });
    if (this.displayId) this.sendDisplays();
    this.syncClipboardWatch();
  }

  private syncClipboardWatch(): void {
    const platform = this.o.platform;
    const want = this.perms.clipboard && this.phase === 'active' && !!platform.watchClipboard;
    if (want && !this.unwatchClipboard) {
      this.unwatchClipboard = platform.watchClipboard!((text) => {
        if (!text || text === this.lastClipboard || text.length > 1_000_000) return;
        this.lastClipboard = text;
        sendControl(this.channels?.control, { t: 'clip', text });
      });
    } else if (!want && this.unwatchClipboard) {
      this.unwatchClipboard();
      this.unwatchClipboard = null;
    }
  }

  private input(cmd: InputCommand): void {
    if (this.phase !== 'active' || !this.perms.control) return;
    this.o.platform.input?.(this.displayId, cmd);
  }

  private onPointer(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) return;
    const m = decodePointerMove(data);
    if (!m) return;
    if (this.lastSeq !== -1 && !seqNewer(m.seq, this.lastSeq)) return; // stale (unordered channel)
    this.lastSeq = m.seq;
    this.input({ k: 'move', x: m.x, y: m.y });
  }

  private onControl(raw: unknown): void {
    if (this.phase !== 'active') return;
    const m = parseControlMessage(raw) as ControlMessage | null;
    if (!m) return;
    switch (m.t) {
      case 'btn':
        this.input({ k: 'button', button: (['left', 'middle', 'right'] as const)[m.b], down: m.down, x: m.x, y: m.y });
        break;
      case 'wheel':
        this.input({ k: 'wheel', dx: clampDelta(m.dx), dy: clampDelta(m.dy), x: m.x, y: m.y });
        break;
      case 'key': {
        const key = codeToKey(m.code);
        if (key) this.input({ k: 'key', key, down: m.down });
        break;
      }
      case 'text':
        this.input({ k: 'text', text: m.text });
        break;
      case 'combo': {
        const keys = m.keys.map(codeToKey).filter((k): k is string => !!k);
        if (keys.length) this.input({ k: 'combo', keys });
        break;
      }
      case 'release-all':
        this.o.platform.input?.(this.displayId, { k: 'release' });
        break;
      case 'select-display':
        if (this.displays.some((d) => d.id === m.id) && m.id !== this.displayId) {
          this.startCapture(m.id).catch(() =>
            sendControl(this.channels?.control, { t: 'notice', level: 'warn', text: 'Could not switch to that display.' }),
          );
        }
        break;
      case 'quality':
        this.quality = m.q;
        void this.applyEncoding();
        break;
      case 'chat': {
        const msg: ChatMessage = { from: 'them', text: m.text, ts: Date.now() };
        this.chat.push(msg);
        this.emit('chat', msg);
        break;
      }
      case 'clip':
        if (this.perms.clipboard && this.o.platform.writeClipboard) {
          this.lastClipboard = m.text;
          void this.o.platform.writeClipboard(m.text);
        }
        break;
      case 'ping':
        sendControl(this.channels?.control, { t: 'pong', ts: m.ts });
        break;
      case 'bye':
        this.close('remote-closed', false);
        break;
    }
  }

  // ------------------------------------------------------------------ public controls

  setPerms(p: Permissions): void {
    const caps = this.o.platform.capabilities();
    const next = { control: p.control && caps.control, clipboard: p.clipboard && caps.clipboard, files: p.files && caps.files, audio: p.audio && caps.audio };
    if (this.perms.control && !next.control) this.o.platform.input?.(this.displayId, { k: 'release' });
    if (this.perms.files && !next.files) this.files.cancelAll();
    const audioChanged = next.audio !== this.perms.audio;
    this.perms = next;
    sendControl(this.channels?.control, { t: 'perms', perms: next });
    this.syncClipboardWatch();
    if (audioChanged && this.audioTx) {
      if (!next.audio) void this.audioTx.sender.replaceTrack(null);
      else void this.startCapture(this.displayId);
    }
    this.emit('perms', next);
  }

  sendChat(text: string): void {
    const t = text.trim().slice(0, 4000);
    if (!t) return;
    const msg: ChatMessage = { from: 'me', text: t, ts: Date.now() };
    if (sendControl(this.channels?.control, { t: 'chat', text: t, ts: msg.ts })) {
      this.chat.push(msg);
      this.emit('chat', msg);
    }
  }

  sendFiles(files: Iterable<File>): void {
    this.files.send(files);
  }

  close(reason = 'local', notify = true): void {
    if (this.phase === 'closed') return;
    if (notify) {
      sendControl(this.channels?.control, { t: 'bye', reason });
      this.signal('bye', { reason });
    }
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.perms.control) this.o.platform.input?.(this.displayId, { k: 'release' });
    this.unwatchClipboard?.();
    this.unwatchClipboard = null;
    this.files.dispose();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.setPhase('closed');
    this.emit('closed', { reason });
  }

  private signal(kind: Parameters<SignalingClient['send']>[2], data: unknown): void {
    this.o.signaling.send(this.viewerId, this.sid, kind, data);
  }

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private setPhase(p: HostPhase): void {
    if (this.phase === p || this.phase === 'closed') return;
    this.phase = p;
    this.emit('phase', p);
    this.service.sessionChanged(this);
  }
}

const clampDelta = (n: number) => Math.max(-10_000, Math.min(10_000, n));
