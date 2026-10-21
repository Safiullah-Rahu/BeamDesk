/**
 * Wire protocol shared by the server, the desktop app and the web app.
 *
 * Three layers:
 *  1. Client <-> signaling server (WebSocket, JSON): registration, presence, relaying.
 *  2. Peer <-> peer via the server ("signal" messages): offer/answer/ICE and the
 *     authentication handshake. The server can read these, which is fine: they are
 *     designed to be safe on an untrusted channel (PAKE + signatures + channel binding).
 *  3. Peer <-> peer over encrypted WebRTC data channels: input, chat, clipboard, files.
 */

export const PROTOCOL_VERSION = 2;
export const APP_VERSION = '1.2.0';

/** Hard limits, enforced on both ends. */
export const LIMITS = {
  /** Max size of a single WebSocket message. */
  wsMessageBytes: 64 * 1024,
  /** Max relayed signal payload. */
  signalBytes: 48 * 1024,
  chatChars: 4000,
  clipboardChars: 1_000_000,
  nameChars: 64,
  fileChunkBytes: 64 * 1024,
} as const;

// ---------------------------------------------------------------------------
// 1. Client <-> server
// ---------------------------------------------------------------------------

export type Platform = 'windows' | 'macos' | 'linux' | 'web' | 'android' | 'ios' | 'unknown';

export interface ServerInfo {
  name: string;
  version: string;
  requiresKey: boolean;
  turn: boolean;
}

export type ClientToServer =
  | { t: 'register'; pk: string; sig: string; name: string; platform: Platform; version: string; key?: string }
  | { t: 'signal'; to: string; sid: string; kind: SignalKind; data: unknown }
  | { t: 'presence'; ids: string[]; rid: number }
  | { t: 'ice'; rid: number }
  | { t: 'ping' };

export type ServerToClient =
  | { t: 'hello'; challenge: string; server: ServerInfo }
  | { t: 'registered'; id: string; ice: RTCIceServer[] }
  | { t: 'signal'; from: string; sid: string; kind: SignalKind; data: unknown }
  | { t: 'undeliverable'; to: string; sid: string; reason: 'offline' | 'rate-limited' }
  | { t: 'presence'; rid: number; online: Record<string, boolean> }
  | { t: 'ice'; rid: number; ice: RTCIceServer[] }
  | { t: 'error'; code: ServerErrorCode; message: string; fatal?: boolean }
  | { t: 'replaced' }
  | { t: 'pong' };

export type ServerErrorCode =
  | 'bad-request'
  | 'bad-signature'
  | 'id-conflict'
  | 'access-key'
  | 'rate-limited'
  | 'not-registered'
  | 'server-full'
  | 'too-large';

// ---------------------------------------------------------------------------
// 2. Peer <-> peer through the server
// ---------------------------------------------------------------------------

export type SignalKind =
  | 'offer'
  | 'answer'
  | 'ice'
  | 'auth'
  | 'pending'
  | 'auth-result'
  | 'bye'
  | 'invite';

export interface OfferData {
  sdp: string;
  restart?: boolean;
  /** Viewer metadata shown in the host's accept prompt. */
  name: string;
  platform: Platform;
  version: string;
  prefs?: { codec?: string; quality?: QualityPreset };
}

/** Host -> viewer: SDP answer plus the first half of authentication. */
export interface AnswerData {
  sdp: string;
  restart?: boolean;
  hello?: HostHello;
}

export interface HostHello {
  v: number;
  /** Host identity public key (base64url). Its hash must equal the ID the viewer dialled. */
  pk: string;
  /** Signature over hostTranscript(sid, ci, viewerId, {shares, canAsk}). */
  sig: string;
  name: string;
  platform: Platform;
  version: string;
  /** CPace shares for each password slot the host has enabled. */
  shares: Partial<Record<'otp' | 'perm', string>>;
  /** Whether the host would show an accept prompt to a viewer without a password. */
  canAsk: boolean;
  caps: HostCapabilities;
}

export interface HostCapabilities {
  control: boolean;
  audio: boolean;
  files: boolean;
  clipboard: boolean;
  multiDisplay: boolean;
}

export interface ViewerAuth {
  /** Viewer identity public key; its hash must equal the viewer's server-verified ID. */
  pk: string;
  sig: string;
  shares: Partial<Record<'otp' | 'perm', string>>;
  tags: Partial<Record<'otp' | 'perm', string>>;
}

export type AuthFailure =
  | 'declined'
  | 'bad-password'
  | 'password-required'
  | 'locked'
  | 'busy'
  | 'timeout'
  | 'blocked'
  | 'bad-identity'
  | 'not-accepting'
  | 'unsupported';

export type AuthResult =
  /** `sig`: host identity signature over acceptTranscript(), so nobody else can forge an acceptance. */
  | { ok: true; slot: 'otp' | 'perm' | null; tag?: string; perms: Permissions; sig: string }
  | { ok: false; reason: AuthFailure };

export interface InviteData {
  name: string;
  platform: Platform;
  /** Free text such as "Please help me with my printer". */
  note?: string;
  /** Token from the helper's help link: the helper only shows invites it asked for. */
  token?: string;
}

/** The password offer is signed too, so nobody in between can strip it (a downgrade to "just ask"). */
export const hostTranscript = (sid: string, ci: string, viewerId: string, offer: Pick<HostHello, 'shares' | 'canAsk'>) =>
  `BeamDesk-host-v2|${sid}|${ci}|${viewerId}|${offer.shares.otp ?? '-'}|${offer.shares.perm ?? '-'}|${+!!offer.canAsk}`;

/** Keeps only well-formed CPace shares (base64url) from an untrusted hello. */
export function cleanShares(shares: unknown): HostHello['shares'] {
  const o = (shares && typeof shares === 'object' ? shares : {}) as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(v);
  return { ...(ok(o.otp) ? { otp: o.otp } : {}), ...(ok(o.perm) ? { perm: o.perm } : {}) };
}
export const viewerTranscript = (sid: string, ci: string, hostId: string) => `BeamDesk-viewer-v1|${sid}|${ci}|${hostId}`;
export const acceptTranscript = (sid: string, ci: string, viewerId: string, slot: string | null, p: Permissions) =>
  `BeamDesk-accept-v1|${sid}|${ci}|${viewerId}|${slot ?? '-'}|${+!!p.control}${+!!p.clipboard}${+!!p.files}${+!!p.audio}`;

// ---------------------------------------------------------------------------
// 3. Data channels
// ---------------------------------------------------------------------------

/** Negotiated data channel ids, created identically on both peers (no extra round trip). */
export const CHANNELS = {
  control: { label: 'ctl', id: 0, ordered: true },
  pointer: { label: 'ptr', id: 1, ordered: false, maxRetransmits: 0 },
  files: { label: 'file', id: 2, ordered: true },
} as const;

export interface Permissions {
  control: boolean;
  clipboard: boolean;
  files: boolean;
  audio: boolean;
}

export const FULL_PERMISSIONS: Permissions = { control: true, clipboard: true, files: true, audio: true };
export const VIEW_ONLY_PERMISSIONS: Permissions = { control: false, clipboard: false, files: false, audio: false };

export interface DisplayInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
}

export type QualityPreset = 'speed' | 'balanced' | 'quality' | 'custom';

export interface QualitySettings {
  preset: QualityPreset;
  /** Only used by the custom preset. */
  fps?: number;
  kbps?: number;
  /** 1 = native resolution, 2 = half width/height. */
  scale?: number;
}

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

/** Ordered, reliable control channel messages. */
export type ControlMessage =
  // viewer -> host
  | { t: 'btn'; b: 0 | 1 | 2; down: boolean; x: number; y: number }
  | { t: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { t: 'key'; code: string; down: boolean }
  | { t: 'text'; text: string }
  | { t: 'combo'; keys: string[] }
  | { t: 'release-all' }
  | { t: 'select-display'; id: string }
  | { t: 'quality'; q: QualitySettings }
  // host -> viewer
  | { t: 'displays'; list: DisplayInfo[]; current: string }
  | { t: 'perms'; perms: Permissions }
  | { t: 'notice'; level: 'info' | 'warn'; text: string }
  // both directions
  | { t: 'chat'; text: string; ts: number }
  | { t: 'clip'; text: string }
  | { t: 'ping'; ts: number }
  | { t: 'pong'; ts: number }
  | { t: 'bye'; reason?: string };

/** Binary pointer move packet on the unordered channel: [type u8][seq u16][x u16][y u16]. */
export const POINTER_MOVE = 1;

export function encodePointerMove(seq: number, x: number, y: number): ArrayBuffer {
  const buf = new ArrayBuffer(7);
  const v = new DataView(buf);
  v.setUint8(0, POINTER_MOVE);
  v.setUint16(1, seq & 0xffff);
  v.setUint16(3, Math.round(clamp01(x) * 65535));
  v.setUint16(5, Math.round(clamp01(y) * 65535));
  return buf;
}

export function decodePointerMove(buf: ArrayBuffer): { seq: number; x: number; y: number } | null {
  if (buf.byteLength !== 7) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== POINTER_MOVE) return null;
  return { seq: v.getUint16(1), x: v.getUint16(3) / 65535, y: v.getUint16(5) / 65535 };
}

/** True when 16-bit sequence number `a` is newer than `b` (handles wrap-around). */
export function seqNewer(a: number, b: number): boolean {
  return ((a - b) & 0xffff) !== 0 && ((a - b) & 0xffff) < 0x8000;
}

export const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Validates untrusted control messages coming off a data channel. */
export function parseControlMessage(raw: unknown): ControlMessage | null {
  if (typeof raw !== 'string' || raw.length > LIMITS.clipboardChars + 1024) return null;
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return null;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
  switch (m.t) {
    case 'btn':
      return [0, 1, 2].includes(m.b) && typeof m.down === 'boolean' && num(m.x) && num(m.y) ? m : null;
    case 'wheel':
      return num(m.dx) && num(m.dy) && num(m.x) && num(m.y) ? m : null;
    case 'key':
      return str(m.code, 32) && typeof m.down === 'boolean' ? m : null;
    case 'text':
      return str(m.text, 4096) ? m : null;
    case 'combo':
      return Array.isArray(m.keys) && m.keys.length <= 6 && m.keys.every((k: unknown) => str(k, 32)) ? m : null;
    case 'select-display':
      return str(m.id, 128) ? m : null;
    case 'quality': {
      if (!m.q || typeof m.q !== 'object' || !['speed', 'balanced', 'quality', 'custom'].includes(m.q.preset)) return null;
      // Clamp custom values: they end up in encoder parameters.
      const q: QualitySettings = { preset: m.q.preset };
      if (num(m.q.fps)) q.fps = Math.round(Math.min(60, Math.max(1, m.q.fps)));
      if (num(m.q.kbps)) q.kbps = Math.round(Math.min(50_000, Math.max(100, m.q.kbps)));
      if (num(m.q.scale)) q.scale = Math.min(4, Math.max(1, m.q.scale));
      return { t: 'quality', q };
    }
    case 'displays': {
      if (!Array.isArray(m.list) || !str(m.current, 128)) return null;
      const list: DisplayInfo[] = m.list
        .slice(0, 16)
        .filter((d: any) => d && typeof d === 'object' && str(d.id, 128))
        .map((d: any) => ({
          id: d.id,
          name: sanitizeName(d.name, 'Display'),
          width: num(d.width) ? Math.max(0, Math.min(16_384, Math.round(d.width))) : 0,
          height: num(d.height) ? Math.max(0, Math.min(16_384, Math.round(d.height))) : 0,
          primary: d.primary === true,
        }));
      return { t: 'displays', list, current: m.current };
    }
    case 'perms':
      return m.perms && typeof m.perms === 'object' ? { t: 'perms', perms: normalizePermissions(m.perms) } : null;
    case 'notice':
      return str(m.text, 300) ? { t: 'notice', level: m.level === 'warn' ? 'warn' : 'info', text: sanitizeText(m.text) } : null;
    case 'chat':
      return str(m.text, LIMITS.chatChars) ? m : null;
    case 'clip':
      return str(m.text, LIMITS.clipboardChars) ? m : null;
    case 'ping':
    case 'pong':
      return num(m.ts) ? m : null;
    case 'release-all':
      return { t: 'release-all' };
    case 'bye':
      return { t: 'bye', reason: typeof m.reason === 'string' && /^[a-z-]{1,32}$/.test(m.reason) ? m.reason : undefined };
    default:
      return null;
  }
}

/** Only real booleans count: `"control": "yes"` from a peer is not a grant. */
export function normalizePermissions(p: unknown): Permissions {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  return { control: o.control === true, clipboard: o.clipboard === true, files: o.files === true, audio: o.audio === true };
}

const PLATFORMS: readonly Platform[] = ['windows', 'macos', 'linux', 'web', 'android', 'ios', 'unknown'];

export function sanitizePlatform(p: unknown): Platform {
  return PLATFORMS.includes(p as Platform) ? (p as Platform) : 'unknown';
}

/** Session IDs are chosen by the viewer: restrict them so they can never alter a signed transcript. */
export const isSessionId = (sid: unknown): sid is string => typeof sid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(sid);

/** Strips control and bidi characters from short free text received from a peer. */
export function sanitizeText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
}

export function sanitizeName(name: unknown, fallback = 'Unknown device'): string {
  if (typeof name !== 'string') return fallback;
  // Strip control and bidi-override characters that could be used to spoof prompts.
  const clean = name.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim();
  return clean.slice(0, LIMITS.nameChars) || fallback;
}
