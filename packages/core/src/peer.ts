/** WebRTC plumbing shared by the host and viewer sessions. */
import { CHANNELS, type ControlMessage } from './protocol.ts';

export interface PeerChannels {
  control: RTCDataChannel;
  pointer: RTCDataChannel;
  files: RTCDataChannel;
}

export interface Peer {
  pc: RTCPeerConnection;
  channels: PeerChannels;
}

/**
 * Creates the peer connection and the three pre-negotiated data channels.
 * Negotiated channels open on both ends at once, without an extra signaling round trip.
 */
export function createPeer(iceServers: RTCIceServer[], forceRelay: boolean): Peer {
  const pc = new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: forceRelay ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 2,
  });
  const control = pc.createDataChannel(CHANNELS.control.label, { negotiated: true, id: CHANNELS.control.id, ordered: true });
  const pointer = pc.createDataChannel(CHANNELS.pointer.label, {
    negotiated: true,
    id: CHANNELS.pointer.id,
    ordered: false,
    maxRetransmits: 0,
  });
  const files = pc.createDataChannel(CHANNELS.files.label, { negotiated: true, id: CHANNELS.files.id, ordered: true });
  pointer.binaryType = 'arraybuffer';
  files.binaryType = 'arraybuffer';
  return { pc, channels: { control, pointer, files } };
}

export function sendControl(channel: RTCDataChannel | null | undefined, msg: ControlMessage): boolean {
  if (!channel || channel.readyState !== 'open') return false;
  try {
    channel.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

/**
 * Holds ICE candidates back until `release()`. The host uses this so that its IP addresses
 * are not revealed - and no connectivity checks are sent - before a request is approved.
 */
const MAX_BUFFERED_CANDIDATES = 64;

export class CandidateGate {
  private open = false;
  private local: RTCIceCandidateInit[] = [];
  private remote: RTCIceCandidateInit[] = [];

  private readonly pc: RTCPeerConnection;
  private readonly sendLocal: (c: RTCIceCandidateInit) => void;

  constructor(pc: RTCPeerConnection, sendLocal: (c: RTCIceCandidateInit) => void, startOpen = false) {
    this.pc = pc;
    this.sendLocal = sendLocal;
    this.open = startOpen;
  }

  get isOpen(): boolean {
    return this.open;
  }

  onLocal(c: RTCIceCandidate | null): void {
    if (!c) return;
    const init = c.toJSON();
    if (this.open) this.sendLocal(init);
    else this.local.push(init);
  }

  async onRemote(c: RTCIceCandidateInit): Promise<void> {
    if (!this.open || !this.pc.remoteDescription) {
      // Bounded: an unapproved peer must not be able to grow this without limit.
      if (this.remote.length < MAX_BUFFERED_CANDIDATES) this.remote.push(c);
      return;
    }
    await this.pc.addIceCandidate(c).catch(() => undefined);
  }

  async release(): Promise<void> {
    this.open = true;
    for (const c of this.local.splice(0)) this.sendLocal(c);
    for (const c of this.remote.splice(0)) await this.pc.addIceCandidate(c).catch(() => undefined);
  }

  /** Called after an ICE restart's remote description is applied. */
  async flushRemote(): Promise<void> {
    if (!this.open) return;
    for (const c of this.remote.splice(0)) await this.pc.addIceCandidate(c).catch(() => undefined);
  }
}

/** Lowers receive-side buffering to the minimum for interactive use (Chromium). */
export function minimiseLatency(receiver: RTCRtpReceiver): void {
  const r = receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number };
  try {
    if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0;
  } catch {
    /* unsupported */
  }
  try {
    if ('playoutDelayHint' in r) r.playoutDelayHint = 0;
  } catch {
    /* unsupported */
  }
}

export function describeConnectionError(reason: string): string {
  const map: Record<string, string> = {
    offline: 'That device is offline or the ID is wrong. Check the ID and make sure BeamDesk is open on the other device.',
    declined: 'The other person declined the connection.',
    'bad-password': 'Wrong password. Check the password and try again.',
    'password-required': 'This device only accepts connections with a password.',
    locked: 'Too many wrong passwords. The device is temporarily locked; try again in a few minutes.',
    busy: 'The other device is busy with another request. Try again in a moment.',
    timeout: 'The other side did not respond in time.',
    blocked: 'This device is not allowed to connect.',
    'bad-identity': 'The identity of the other device could not be verified.',
    'identity-changed': 'The other device’s security key has changed since your last session. This can happen after reinstalling BeamDesk — or if someone is intercepting the connection.',
    'host-proof': 'The other device could not prove it knows the password. The connection was stopped for your safety.',
    'password-unavailable': 'The other device does not accept passwords right now, so its identity could not be confirmed. Connect without a password and ask the person to accept.',
    'capture-ended': 'The other side stopped sharing their screen.',
    unsupported: 'The other device runs an incompatible BeamDesk version.',
    'remote-closed': 'The session was ended by the other side.',
    'connection-failed': 'The connection was lost and could not be restored.',
    'capture-failed': 'The other device could not share its screen.',
    'not-accepting': 'The other device is not accepting connections right now.',
    'server': 'Not connected to the BeamDesk server.',
    local: 'Session ended.',
  };
  // Reasons can come from the other device: never display unknown text verbatim.
  return Object.hasOwn(map, reason) ? map[reason] : 'The session ended.';
}
