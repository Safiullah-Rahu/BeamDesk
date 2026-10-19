/**
 * ViewerSession: the side that watches and controls a remote device.
 *
 * Handshake (all through the signaling server, before any media or IP exchange):
 *   viewer --offer--> host
 *   viewer <--answer + hello (host identity signature, CPace shares)-- host
 *   viewer --auth (viewer identity signature, CPace shares + confirmation tags)--> host
 *   viewer <--pending (accept prompt shown)-- host              (optional)
 *   viewer <--auth-result (host confirmation tag, permissions)-- host
 * Only after a successful auth-result does the host release its ICE candidates.
 */
import { channelIdentifier, fingerprintKey, orderCodecs, splitCandidates, type CodecName, type CodecPreference } from './sdp.ts';
import {
  confirmationTag,
  cpaceFinish,
  cpaceStart,
  derivePasswordSecret,
  PASSWORD_SLOTS,
  securityCode,
  verifyConfirmation,
  type PasswordSlot,
} from './cpace.ts';
import { Identity, keyHash, publicKeyMatchesId, verifySignature } from './identity.ts';
import {
  acceptTranscript,
  APP_VERSION,
  encodePointerMove,
  hostTranscript,
  parseControlMessage,
  PROTOCOL_VERSION,
  sanitizeName,
  viewerTranscript,
  type AnswerData,
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
import { createPeer, describeConnectionError, minimiseLatency, sendControl, type PeerChannels } from './peer.ts';
import { FileTransfers, type FileSinkFactory, type Transfer } from './files.ts';
import type { IncomingSignal, SignalingClient } from './signaling.ts';
import { StatsSampler, type ConnectionStats } from './stats.ts';
import { translateModifierCode } from './keymap.ts';
import { Emitter, fromBase64Url, randomId, toBase64Url, utf8 } from './util.ts';

export type ViewerState = 'connecting' | 'authenticating' | 'waiting' | 'starting' | 'connected' | 'reconnecting' | 'closed';

export interface ViewerOptions {
  signaling: SignalingClient;
  identity: Identity;
  hostId: string;
  password?: string;
  deviceName: string;
  platform: Platform;
  forceRelay?: boolean;
  codec?: CodecPreference;
  quality?: QualitySettings;
  /** Host public key remembered from an earlier session (trust on first use). */
  pinnedKey?: string;
  /** The user explicitly accepted that the host's key changed. */
  acceptNewKey?: boolean;
  /** 128-bit key hash from an invite link: the host must have exactly this key. */
  expectedKeyHash?: string;
  /** Translate Cmd <-> Ctrl between macOS and other systems. */
  swapCmdCtrl?: boolean;
  fileSink: FileSinkFactory;
}

export interface RemoteHostInfo {
  id: string;
  name: string;
  platform: Platform;
  version: string;
  publicKey: string;
  caps: HostCapabilities;
  securityCode: string;
  /** How this session was authorised. */
  via: PasswordSlot | 'approval' | null;
}

export interface ChatMessage {
  from: 'me' | 'them';
  text: string;
  ts: number;
}

type Events = {
  state: ViewerState;
  stream: MediaStream;
  host: RemoteHostInfo;
  displays: { list: DisplayInfo[]; current: string };
  perms: Permissions;
  chat: ChatMessage;
  clipboard: string;
  notice: { level: 'info' | 'warn'; text: string };
  transfers: Transfer[];
  'file-received': Transfer;
  closed: { reason: string; message: string };
};

export class ViewerSession extends Emitter<Events> {
  readonly sid = randomId();
  readonly hostId: string;
  state: ViewerState = 'connecting';
  host: RemoteHostInfo | null = null;
  stream: MediaStream | null = null;
  perms: Permissions = { ...VIEW_ONLY_PERMISSIONS };
  displays: DisplayInfo[] = [];
  currentDisplay = '';
  chat: ChatMessage[] = [];
  viewOnly = false;
  closeReason: string | null = null;
  readonly files: FileTransfers;

  private pc: RTCPeerConnection | null = null;
  private channels: PeerChannels | null = null;
  private ci = '';
  /** The host's verified DTLS certificate, pinned for ICE restarts. */
  private remoteFingerprints = '';
  private isk: Partial<Record<PasswordSlot, Uint8Array>> = {};
  private accepted = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private offs: (() => void)[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private restarts = 0;
  private seq = 0;
  private lastClipboard = '';
  private sampler = new StatsSampler();

  private readonly opts: ViewerOptions;

  constructor(opts: ViewerOptions) {
    super();
    this.opts = opts;
    this.hostId = opts.hostId;
    this.files = new FileTransfers(opts.fileSink, () => this.perms.files);
    this.files.on('update', (list) => this.emit('transfers', list));
    this.files.on('received', (t) => this.emit('file-received', t));
  }

  get canControl(): boolean {
    return this.state === 'connected' && !this.viewOnly && this.perms.control && !!this.host?.caps.control;
  }

  get peerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  async start(): Promise<void> {
    const { signaling } = this.opts;
    try {
      await signaling.waitOnline(8000);
    } catch {
      return this.finish('server');
    }
    if (this.state === 'closed') return; // closed while waiting for the server
    if (this.hostId === signaling.id) return this.finish('self');

    this.offs.push(
      signaling.on('signal', (s) => {
        if (s.from === this.hostId && s.sid === this.sid) void this.onSignal(s);
      }),
      signaling.on('undeliverable', (u) => {
        if (u.sid === this.sid && u.to === this.hostId && !this.accepted) this.finish(u.reason === 'offline' ? 'offline' : 'busy');
      }),
    );

    const ice = await signaling.refreshIce();
    if ((this.state as ViewerState) === 'closed') return;
    const { pc, channels } = createPeer(ice, !!this.opts.forceRelay);
    this.pc = pc;
    this.channels = channels;

    const video = pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    if (this.opts.codec && this.opts.codec !== 'auto') this.preferCodec(video, this.opts.codec);

    pc.ontrack = (e) => {
      minimiseLatency(e.receiver);
      if (!this.stream) {
        this.stream = new MediaStream();
      }
      if (!this.stream.getTracks().includes(e.track)) this.stream.addTrack(e.track);
      this.emit('stream', this.stream);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal('ice', e.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => this.onConnectionState();

    channels.control.onopen = () => {
      if (this.state === 'starting' || this.state === 'reconnecting') this.setState('connected');
      if (this.opts.quality) this.setQuality(this.opts.quality);
    };
    channels.control.onmessage = (e) => this.onControl(e.data);
    channels.control.onclose = () => {
      if (this.state !== 'closed') this.finish('remote-closed');
    };
    this.files.attach(channels.files);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const data: OfferData = {
      sdp: offer.sdp!,
      name: this.opts.deviceName,
      platform: this.opts.platform,
      version: APP_VERSION,
      prefs: { codec: this.opts.codec ?? 'auto', quality: this.opts.quality?.preset },
    };
    if (!this.signal('offer', data)) return this.finish('server');
    this.after(20_000, () => {
      if (this.state === 'connecting') this.close('timeout');
    });
  }

  // ------------------------------------------------------------------ input

  pointerMove(x: number, y: number): void {
    if (!this.canControl) return;
    const ch = this.channels?.pointer;
    if (ch?.readyState === 'open' && ch.bufferedAmount < 16 * 1024) ch.send(encodePointerMove(this.seq++, x, y));
  }

  pointerButton(button: 0 | 1 | 2, down: boolean, x: number, y: number): void {
    if (this.canControl) this.control({ t: 'btn', b: button, down, x, y });
  }

  wheel(dx: number, dy: number, x: number, y: number): void {
    if (this.canControl) this.control({ t: 'wheel', dx, dy, x, y });
  }

  key(code: string, down: boolean): void {
    if (!this.canControl) return;
    this.control({ t: 'key', code: this.translate(code), down });
  }

  text(text: string): void {
    if (this.canControl && text) this.control({ t: 'text', text: text.slice(0, 4096) });
  }

  combo(codes: string[]): void {
    if (this.canControl) this.control({ t: 'combo', keys: codes.map((c) => this.translate(c)) });
  }

  releaseAll(): void {
    this.control({ t: 'release-all' });
  }

  setViewOnly(v: boolean): void {
    if (v && !this.viewOnly) this.releaseAll();
    this.viewOnly = v;
    this.emit('perms', this.perms);
  }

  // ------------------------------------------------------------------ features

  selectDisplay(id: string): void {
    this.control({ t: 'select-display', id });
  }

  setQuality(q: QualitySettings): void {
    this.control({ t: 'quality', q });
  }

  sendChat(text: string): void {
    const t = text.trim().slice(0, 4000);
    if (!t) return;
    const msg: ChatMessage = { from: 'me', text: t, ts: Date.now() };
    if (this.control({ t: 'chat', text: t, ts: msg.ts })) {
      this.chat.push(msg);
      this.emit('chat', msg);
    }
  }

  /** Pushes local clipboard text to the remote device (no-op if unchanged). */
  sendClipboard(text: string): void {
    if (!this.perms.clipboard || this.viewOnly || !text || text === this.lastClipboard) return;
    this.lastClipboard = text;
    this.control({ t: 'clip', text });
  }

  sendFiles(files: Iterable<File>): void {
    this.files.send(files);
  }

  stats(): Promise<ConnectionStats | null> {
    return this.pc ? this.sampler.sample(this.pc).catch(() => null) : Promise.resolve(null);
  }

  close(reason = 'local'): void {
    if (this.state === 'closed') return;
    sendControl(this.channels?.control, { t: 'bye', reason });
    this.signal('bye', { reason });
    this.finish(reason);
  }

  // ------------------------------------------------------------------ internals

  private translate(code: string): string {
    return translateModifierCode(code, this.opts.platform, this.host?.platform ?? 'unknown', this.opts.swapCmdCtrl !== false);
  }

  private control(msg: ControlMessage): boolean {
    return sendControl(this.channels?.control, msg);
  }

  private signal(kind: Parameters<SignalingClient['send']>[2], data: unknown): boolean {
    return this.opts.signaling.send(this.hostId, this.sid, kind, data);
  }

  private preferCodec(t: RTCRtpTransceiver, codec: CodecName): void {
    try {
      const caps = RTCRtpReceiver.getCapabilities('video');
      if (caps && 'setCodecPreferences' in t) t.setCodecPreferences(orderCodecs(caps.codecs, [codec]));
    } catch {
      /* keep defaults */
    }
  }

  private async onSignal(s: IncomingSignal): Promise<void> {
    try {
      switch (s.kind) {
        case 'answer':
          await this.onAnswer(s.data as AnswerData);
          break;
        case 'pending':
          this.setState('waiting');
          this.after(70_000, () => {
            if (this.state === 'waiting') this.close('timeout');
          });
          break;
        case 'auth-result':
          this.onAuthResult(s.data as AuthResult);
          break;
        case 'ice':
          if (s.data && typeof s.data === 'object') {
            if (this.pc?.remoteDescription) await this.pc.addIceCandidate(s.data).catch(() => undefined);
            else if (this.pendingIce.length < 64) this.pendingIce.push(s.data);
          }
          break;
        case 'bye':
          this.finish(typeof s.data?.reason === 'string' && s.data.reason !== 'local' ? s.data.reason : 'remote-closed');
          break;
      }
    } catch (err) {
      console.warn('[beamdesk] viewer signal failed', err);
      this.close('connection-failed');
    }
  }

  private async onAnswer(a: AnswerData): Promise<void> {
    const pc = this.pc;
    if (!pc || !a || typeof a.sdp !== 'string') return;
    const { sdp: clean, candidates } = splitCandidates(a.sdp);
    if (a.restart) {
      // Only answers to our own ICE restart, and only from the certificate we already verified.
      if (!this.accepted || this.state !== 'reconnecting' || pc.signalingState !== 'have-local-offer') return;
      if (fingerprintKey(clean) !== this.remoteFingerprints) return this.close('bad-identity');
      await pc.setRemoteDescription({ type: 'answer', sdp: clean });
      for (const c of candidates) await pc.addIceCandidate(c).catch(() => undefined);
      return;
    }
    if (this.state !== 'connecting' || pc.signalingState !== 'have-local-offer') return;
    await pc.setRemoteDescription({ type: 'answer', sdp: clean });

    const hello = a.hello as HostHello | undefined;
    if (!hello || hello.v !== PROTOCOL_VERSION) return this.close('unsupported');
    this.ci = channelIdentifier(pc.localDescription!.sdp, pc.remoteDescription!.sdp);

    // 1. Is this really the device behind the ID we dialled?
    const me = this.opts.signaling.id;
    if (!publicKeyMatchesId(hello.pk, this.hostId) || !verifySignature(hello.pk, utf8(hostTranscript(this.sid, this.ci, me)), hello.sig)) {
      return this.close('bad-identity');
    }
    if (this.opts.expectedKeyHash && keyHash(hello.pk) !== this.opts.expectedKeyHash) {
      return this.close('bad-identity');
    }
    if (this.opts.pinnedKey && this.opts.pinnedKey !== hello.pk && !this.opts.acceptNewKey) {
      return this.close('identity-changed');
    }
    this.remoteFingerprints = fingerprintKey(clean);
    // The host is verified: now its candidates may be used.
    for (const c of [...candidates, ...this.pendingIce.splice(0)]) await pc.addIceCandidate(c).catch(() => undefined);
    this.host = {
      id: this.hostId,
      name: sanitizeName(hello.name),
      platform: hello.platform,
      version: String(hello.version || ''),
      publicKey: hello.pk,
      caps: { control: !!hello.caps?.control, audio: !!hello.caps?.audio, files: !!hello.caps?.files, clipboard: !!hello.caps?.clipboard, multiDisplay: !!hello.caps?.multiDisplay },
      securityCode: securityCode(this.ci),
      via: null,
    };
    this.emit('host', this.host);

    // 2. Password authentication (CPace), one parallel instance per slot the host offers.
    const shares: ViewerAuth['shares'] = {};
    const tags: ViewerAuth['tags'] = {};
    const password = this.opts.password?.trim();
    if (password) {
      for (const slot of PASSWORD_SLOTS) {
        const theirs = hello.shares?.[slot];
        if (typeof theirs !== 'string') continue;
        const prs = await derivePasswordSecret(slot, password, this.hostId);
        const st = cpaceStart(prs, this.ci, this.sid, slot);
        const isk = cpaceFinish(st, fromBase64Url(theirs), 'viewer');
        this.isk[slot] = isk;
        shares[slot] = toBase64Url(st.Y);
        tags[slot] = toBase64Url(confirmationTag(isk, 'viewer', this.sid, this.ci));
      }
    }
    if ((this.state as ViewerState) === 'closed') return;
    const auth: ViewerAuth = {
      pk: this.opts.identity.publicKeyB64,
      sig: this.opts.identity.sign(utf8(viewerTranscript(this.sid, this.ci, this.hostId))),
      shares,
      tags,
    };
    this.setState('authenticating');
    this.signal('auth', auth);
  }

  private onAuthResult(r: AuthResult): void {
    if (this.accepted || this.state === 'closed' || !r) return;
    if (!r.ok) return this.finish(typeof r.reason === 'string' ? r.reason : 'declined');
    // Acceptance is only meaningful after we verified the host and sent our authentication,
    // and it must be signed by that host (the server cannot forge it).
    if (!this.host || (this.state !== 'authenticating' && this.state !== 'waiting')) return;
    const perms: Permissions = { ...VIEW_ONLY_PERMISSIONS, ...r.perms };
    const slot = r.slot === 'otp' || r.slot === 'perm' ? r.slot : null;
    if (typeof r.sig !== 'string' || !verifySignature(this.host.publicKey, utf8(acceptTranscript(this.sid, this.ci, this.opts.signaling.id, slot, perms)), r.sig)) {
      return this.close('bad-identity');
    }
    if (r.slot) {
      // Mutual authentication: the host must prove it knows the same password.
      const isk = this.isk[r.slot];
      if (!isk || typeof r.tag !== 'string' || !verifyConfirmation(isk, 'host', this.sid, this.ci, fromBase64Url(r.tag))) {
        return this.close('host-proof');
      }
    }
    this.accepted = true;
    if (this.host) {
      this.host.via = r.slot ?? 'approval';
      this.emit('host', this.host);
    }
    this.perms = perms;
    this.emit('perms', this.perms);
    this.setState(this.channels?.control.readyState === 'open' ? 'connected' : 'starting');
    // If the transport has not come up quickly (e.g. a stale candidate pair), renegotiate ICE.
    this.after(8_000, () => {
      if (this.state === 'starting') void this.restartIce();
    });
    this.after(45_000, () => {
      if (this.state === 'starting' || this.state === 'reconnecting') this.close('connection-failed');
    });
  }

  private onControl(raw: unknown): void {
    const m = parseControlMessage(raw);
    if (!m) return;
    switch (m.t) {
      case 'displays':
        this.displays = m.list.slice(0, 16);
        this.currentDisplay = m.current;
        this.emit('displays', { list: this.displays, current: this.currentDisplay });
        break;
      case 'perms':
        this.perms = { ...VIEW_ONLY_PERMISSIONS, ...m.perms };
        this.emit('perms', this.perms);
        break;
      case 'chat': {
        const msg: ChatMessage = { from: 'them', text: m.text, ts: Date.now() };
        this.chat.push(msg);
        this.emit('chat', msg);
        break;
      }
      case 'clip':
        if (this.perms.clipboard && !this.viewOnly) {
          this.lastClipboard = m.text;
          this.emit('clipboard', m.text);
        }
        break;
      case 'notice':
        this.emit('notice', { level: m.level === 'warn' ? 'warn' : 'info', text: m.text });
        break;
      case 'ping':
        this.control({ t: 'pong', ts: m.ts });
        break;
      case 'bye':
        this.finish(m.reason && m.reason !== 'local' ? m.reason : 'remote-closed');
        break;
    }
  }

  private onConnectionState(): void {
    const pc = this.pc;
    if (!pc || this.state === 'closed') return;
    const s = pc.connectionState;
    if (s === 'connected') {
      if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
      this.restarts = 0;
      if (this.state === 'reconnecting' || (this.state === 'starting' && this.channels?.control.readyState === 'open')) this.setState('connected');
    } else if (s === 'disconnected' && this.accepted) {
      this.disconnectTimer ??= setTimeout(() => {
        this.disconnectTimer = null;
        if (this.pc?.connectionState !== 'connected') void this.restartIce();
      }, 3000);
    } else if (s === 'failed' && this.accepted) {
      void this.restartIce();
    }
  }

  /** Recovers from network changes (Wi-Fi to 4G, VPN on/off...) without a new session. */
  private async restartIce(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.state === 'closed') return;
    if (this.restarts >= 5) return this.close('connection-failed');
    this.restarts++;
    this.setState('reconnecting');
    try {
      if (pc.signalingState !== 'stable') await pc.setLocalDescription({ type: 'rollback' }).catch(() => undefined);
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      this.signal('offer', { sdp: offer.sdp!, restart: true, name: this.opts.deviceName, platform: this.opts.platform, version: APP_VERSION } satisfies OfferData);
    } catch (err) {
      console.warn('[beamdesk] ICE restart failed', err);
    }
    this.after(12_000, () => {
      if (this.state === 'reconnecting') void this.restartIce();
    });
  }

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private finish(reason: string): void {
    if (this.state === 'closed') return;
    this.closeReason = reason;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    for (const off of this.offs) off();
    this.offs = [];
    this.files.dispose();
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.setState('closed');
    const message = reason === 'self' ? 'That is the ID of this device. Enter the ID shown on the other device.' : describeConnectionError(reason);
    this.emit('closed', { reason, message });
  }

  private setState(s: ViewerState): void {
    if (this.state === s || this.state === 'closed') return;
    this.state = s;
    this.emit('state', s);
  }
}
