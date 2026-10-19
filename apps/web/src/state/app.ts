/**
 * Application state and the "engine" that wires identity, signaling, hosting and viewing.
 * UI components read the signals below; they never talk to WebRTC directly.
 */
import { batch, computed, signal } from '@preact/signals';
import {
  derivePasswordSecret,
  formatId,
  fromBase64Url,
  generateOneTimePassword,
  HostService,
  Identity,
  isKeyHash,
  keyHash,
  normalizeServerUrl,
  parseId,
  randomId,
  SignalingClient,
  toBase64Url,
  ViewerSession,
  type HostSession,
  type HostSettings,
  type IncomingRequest,
  type Permissions,
  type SignalingState,
  type StoredIdentity,
  type TrustStore,
} from '@beamdesk/core';
import { platform } from '../platform/index.ts';
import { defaultSettings, mergeSettings, type BlockedDevice, type Contact, type Settings, type TrustedDevice } from './settings.ts';
import { chime } from '../ui/sound.ts';

export interface Tab {
  key: string;
  hostId: string;
  session: ViewerSession;
  /** Shown in the tab strip; replaced by the host's name once known. */
  title: string;
}

export interface Toast {
  id: number;
  text: string;
  level: 'info' | 'success' | 'warn' | 'error';
  action?: { label: string; run: () => void };
}

export interface Invite {
  sid: string;
  from: string;
  name: string;
  note?: string;
  at: number;
}

export interface HelpRequest {
  helperId: string;
  /** Key hash from the help link: only that exact device is let in. */
  helperKey: string;
  helperName: string;
  status: 'idle' | 'starting' | 'waiting' | 'sharing' | 'error';
  error?: string;
}

const stored = platform.store;
const defaults = defaultSettings(platform.os, platform.kind);

export const settings = signal<Settings>(mergeSettings(defaults, stored.data.settings));
export const serverState = signal<SignalingState>('offline');
export const serverError = signal<string | null>(null);
export const myId = signal('');
export const myPublicKey = signal('');
export const otp = signal('');
export const tabs = signal<Tab[]>([]);
export const activeTab = signal<string>('home');
export const settingsOpen = signal(false);
export const requests = signal<IncomingRequest[]>([]);
export const hosted = signal<HostSession[]>([]);
export const contacts = signal<Contact[]>(Array.isArray(stored.data.contacts) ? (stored.data.contacts as Contact[]) : []);
export const presence = signal<Record<string, boolean>>({});
export const toasts = signal<Toast[]>([]);
export const invites = signal<Invite[]>([]);
export const trusted = signal<TrustedDevice[]>(Array.isArray(stored.data.trusted) ? (stored.data.trusted as TrustedDevice[]) : []);
export const blocked = signal<BlockedDevice[]>(Array.isArray(stored.data.blocked) ? (stored.data.blocked as BlockedDevice[]) : []);
export const hasPermanentPassword = signal(!!stored.secrets.permPrs);
/** Browsers only accept incoming sessions while the user has chosen to share. */
export const sharing = signal(platform.kind === 'desktop');
export const help = signal<HelpRequest | null>(null);
export const serverUrls = computed(() => normalizeServerUrl(settings.value.serverUrl || platform.defaultServer));
export const needsServer = computed(() => !serverUrls.value);

let identity: Identity;
let signaling: SignalingClient | null = null;
let host: HostService | null = null;
let otpSecret: Uint8Array | null = null;
let permSecret: Uint8Array | null = stored.secrets.permPrs ? safeB64(stored.secrets.permPrs) : null;
let toastSeq = 0;
let presenceTimer: ReturnType<typeof setInterval> | null = null;

function safeB64(s: string): Uint8Array | null {
  try {
    return fromBase64Url(s);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ toasts

export function toast(text: string, level: Toast['level'] = 'info', action?: Toast['action'], ms = 4500): void {
  const id = ++toastSeq;
  toasts.value = [...toasts.value.slice(-3), { id, text, level, action }];
  setTimeout(() => dismissToast(id), action ? ms * 2 : ms);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

// ------------------------------------------------------------------ settings

export function updateSettings(patch: Partial<Settings>): void {
  const prev = settings.value;
  const next = { ...prev, ...patch };
  settings.value = next;
  stored.set('settings', next);
  if (patch.launchAtLogin !== undefined) platform.desktop?.setLaunchAtLogin(next.launchAtLogin);
  if (patch.otpLength !== undefined && patch.otpLength !== prev.otpLength) void rotateOtp();
  if (patch.oneTimePassword === true && !otp.value) void rotateOtp();
  syncHostSettings();
  if (
    signaling &&
    (patch.serverUrl !== undefined || patch.accessKey !== undefined || patch.deviceName !== undefined) &&
    (prev.serverUrl !== next.serverUrl || prev.accessKey !== next.accessKey || prev.deviceName !== next.deviceName)
  ) {
    restartSignaling();
  }
}

function hostSettings(): HostSettings {
  const s = settings.value;
  return {
    access: sharing.value ? s.access : 'off',
    oneTimePassword: s.oneTimePassword,
    askEvenWithPassword: s.askEvenWithPassword,
    unattended: platform.kind === 'desktop' && s.unattended && !!permSecret,
    trustedAutoAccept: s.trustedAutoAccept,
    forceRelay: s.forceRelay,
    maxSessions: s.maxSessions,
    defaultPerms: s.defaultPerms,
    quality: s.quality,
    codec: s.codec,
    shareAudio: s.shareAudio,
  };
}

function syncHostSettings(): void {
  host?.update({ settings: hostSettings(), secrets: { otp: otpSecret, perm: permSecret }, deviceName: settings.value.deviceName });
}

/** Browser hosting: call from a click handler so the screen picker may open. */
export async function setSharing(on: boolean): Promise<void> {
  if (on) {
    try {
      await platform.host.prepareCapture?.(() => void setSharing(false));
    } catch {
      toast('Screen sharing was cancelled.', 'warn');
      return;
    }
    sharing.value = true;
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined);
    }
  } else {
    sharing.value = false;
    platform.host.releasePreparedCapture?.();
    host?.endAll('local');
    if (help.value) help.value = null;
  }
  syncHostSettings();
}

// ------------------------------------------------------------------ passwords

export async function rotateOtp(): Promise<void> {
  const pw = generateOneTimePassword(Math.min(12, Math.max(6, settings.value.otpLength)));
  otpSecret = await derivePasswordSecret('otp', pw, identity.id);
  otp.value = pw;
  syncHostSettings();
}

export async function setPermanentPassword(pw: string | null): Promise<void> {
  if (pw) {
    permSecret = await derivePasswordSecret('perm', pw, identity.id);
    stored.setSecret('permPrs', toBase64Url(permSecret));
  } else {
    permSecret = null;
    stored.setSecret('permPrs', null);
  }
  hasPermanentPassword.value = !!permSecret;
  syncHostSettings();
}

function savedPasswords(): Record<string, string> {
  try {
    return JSON.parse(stored.secrets.passwords || '{}');
  } catch {
    return {};
  }
}

export function savedPassword(id: string): string {
  return savedPasswords()[id] ?? '';
}

export function rememberPassword(id: string, pw: string | null): void {
  const all = savedPasswords();
  if (pw) all[id] = pw;
  else delete all[id];
  stored.setSecret('passwords', JSON.stringify(all));
}

// ------------------------------------------------------------------ contacts & trust

function saveContacts(list: Contact[]): void {
  contacts.value = list;
  stored.set('contacts', list);
}

export function upsertContact(c: Partial<Contact> & { id: string }): void {
  const list = contacts.value.filter((x) => x.id !== c.id);
  const existing = contacts.value.find((x) => x.id === c.id);
  const merged: Contact = { favorite: false, lastConnected: 0, name: formatId(c.id), ...existing, ...c };
  saveContacts([merged, ...list].slice(0, 200));
}

export function removeContact(id: string): void {
  saveContacts(contacts.value.filter((c) => c.id !== id));
  rememberPassword(id, null);
}

const trustStore: TrustStore = {
  isTrusted: (id, pk) => trusted.value.some((t) => t.id === id && t.pk === pk),
  isBlocked: (id) => blocked.value.some((b) => b.id === id),
  trust(id, pk, name) {
    trusted.value = [{ id, pk, name, added: Date.now() }, ...trusted.value.filter((t) => t.id !== id)];
    stored.set('trusted', trusted.value);
  },
  block(id, name) {
    blocked.value = [{ id, name, added: Date.now() }, ...blocked.value.filter((b) => b.id !== id)];
    stored.set('blocked', blocked.value);
  },
};

export function untrust(id: string): void {
  trusted.value = trusted.value.filter((t) => t.id !== id);
  stored.set('trusted', trusted.value);
}

export function unblock(id: string): void {
  blocked.value = blocked.value.filter((b) => b.id !== id);
  stored.set('blocked', blocked.value);
}

// ------------------------------------------------------------------ signaling & hosting

function restartSignaling(): void {
  host?.stop();
  signaling?.stop();
  signaling = null;
  host = null;
  startSignaling();
}

function startSignaling(): void {
  const urls = serverUrls.value;
  if (!urls) return;
  const s = settings.value;
  signaling = new SignalingClient({ url: urls.ws, identity, name: s.deviceName, platform: platform.os, accessKey: s.accessKey });
  signaling.on('error', (e) => {
    if (e.code === 'id-conflict') void regenerateIdentity();
  });
  signaling.on('state', (st) => {
    serverState.value = st;
    if (st === 'online') {
      serverError.value = null;
      void refreshPresence();
    }
    if (st === 'error') serverError.value = signaling?.lastError?.message ?? 'Cannot connect to the server';
    if (st === 'replaced') serverError.value = 'BeamDesk was opened in another window or tab.';
    updateTray();
  });
  signaling.on('signal', (sig) => {
    if (sig.kind !== 'invite') return;
    const name = typeof sig.data?.name === 'string' ? sig.data.name.slice(0, 64) : formatId(sig.from);
    invites.value = [...invites.value.filter((i) => i.from !== sig.from), { sid: sig.sid, from: sig.from, name, note: sig.data?.note, at: Date.now() }];
    if (settings.value.sounds) chime();
    platform.notify('Screen shared with you', `${name} wants to show you their screen.`);
    platform.attention();
  });

  host = new HostService({
    signaling,
    identity,
    platform: platform.host,
    settings: hostSettings(),
    secrets: { otp: otpSecret, perm: permSecret },
    trust: trustStore,
    deviceName: s.deviceName,
    devicePlatform: platform.os,
  });
  host.on('request', (r) => {
    requests.value = [...requests.value, r];
    if (settings.value.sounds) chime();
    if (settings.value.notifications) platform.notify('Connection request', `${r.name} (${formatId(r.viewerId)}) wants to connect.`);
    platform.attention();
  });
  host.on('request-closed', (sid) => (requests.value = requests.value.filter((r) => r.sid !== sid)));
  let lastCount = 0;
  host.on('sessions', (list) => {
    hosted.value = list;
    const count = list.length;
    if (count > lastCount) {
      const s = list[list.length - 1];
      toast(`${s.viewerName} is now connected to this device`, 'info');
    }
    if (lastCount > 0 && count === 0 && settings.value.lockOnEnd) platform.desktop?.lockScreen();
    lastCount = count;
    if (help.value?.status === 'waiting' && count > 0) help.value = { ...help.value, status: 'sharing' };
    if (help.value?.status === 'sharing' && count === 0) help.value = { ...help.value, status: 'idle' };
    updateTray();
    updateSessionBar();
  });
  host.on('otp-used', () => {
    if (settings.value.otpRotate === 'session') void rotateOtp();
  });
  host.on('auth-failure', (f) => {
    if (f.reason === 'bad-password') toast(`Blocked a connection attempt with a wrong password from ${formatId(f.viewerId)}`, 'warn');
  });
  host.start();
  signaling.start();
}

let regenerations = 0;

/** The server already knows our ID with another key (a collision or a squatter): get a new one. */
async function regenerateIdentity(): Promise<void> {
  if (regenerations++ >= 3) return;
  const old = myId.value;
  identity = Identity.generate();
  stored.setSecret('identity', JSON.stringify(identity.toStored()));
  myId.value = identity.id;
  myPublicKey.value = identity.publicKeyB64;
  // Password secrets are bound to the device ID.
  if (permSecret) {
    await setPermanentPassword(null);
    updateSettings({ unattended: false });
    toast('Please set your permanent password again (Settings → Security).', 'warn', undefined, 12_000);
  }
  if (settings.value.oneTimePassword) await rotateOtp();
  restartSignaling();
  toast(`ID ${formatId(old)} is already used by another device on this server, so this device got a new ID: ${formatId(identity.id)}.`, 'warn', undefined, 12_000);
}

export function reclaimConnection(): void {
  signaling?.reclaim();
}

export function retryServer(): void {
  if (signaling) signaling.reclaim();
  else startSignaling();
}

async function refreshPresence(): Promise<void> {
  if (!signaling || signaling.state !== 'online' || !contacts.value.length) return;
  presence.value = await signaling.presence(contacts.value.map((c) => c.id));
}

function updateTray(): void {
  platform.desktop?.setTrayStatus({ id: myId.value, sessions: hosted.value.length, online: serverState.value === 'online' });
}

function updateSessionBar(): void {
  platform.desktop?.setSessionBar({
    sessions: hosted.value.map((s) => ({ sid: s.sid, name: s.viewerName, viewerId: s.viewerId, control: s.perms.control })),
  });
}

export function endHostedSession(sid: string): void {
  host?.sessions.get(sid)?.close('local');
}

export function endAllHosted(): void {
  host?.endAll('local');
}

export function refreshHosted(): void {
  hosted.value = [...(host?.active() ?? [])];
  updateSessionBar();
}

// ------------------------------------------------------------------ viewing

export interface ConnectOptions {
  password?: string;
  remember?: boolean;
  acceptNewKey?: boolean;
  viewOnly?: boolean;
  expectedKeyHash?: string;
}

export function connect(rawId: string, opts: ConnectOptions = {}): string | null {
  const id = parseId(rawId);
  if (!id) {
    toast('Enter the 9-digit ID shown on the other device.', 'warn');
    return null;
  }
  if (id === myId.value) {
    toast('That is the ID of this device. Enter the ID shown on the other device.', 'warn');
    return null;
  }
  if (!signaling) {
    toast('Set up your BeamDesk server first (Settings → Network).', 'warn');
    settingsOpen.value = true;
    return null;
  }
  const existing = tabs.value.find((t) => t.hostId === id && t.session.state !== 'closed');
  if (existing) {
    activeTab.value = existing.key;
    return existing.key;
  }
  const contact = contacts.value.find((c) => c.id === id);
  const password = opts.password ?? savedPassword(id);
  if (opts.remember && opts.password) rememberPassword(id, opts.password);
  const s = settings.value;
  const session = new ViewerSession({
    signaling,
    identity,
    hostId: id,
    password: password || undefined,
    deviceName: s.deviceName,
    platform: platform.os,
    forceRelay: s.forceRelay,
    codec: s.codec,
    quality: s.quality,
    pinnedKey: contact?.pk,
    acceptNewKey: opts.acceptNewKey,
    expectedKeyHash: opts.expectedKeyHash,
    swapCmdCtrl: s.swapCmdCtrl,
    fileSink: platform.viewerFileSink,
  });
  if (opts.viewOnly) session.viewOnly = true;
  session.on('host', (info) => {
    const tab = tabs.value.find((t) => t.session === session);
    if (tab) tabs.value = tabs.value.map((t) => (t === tab ? { ...t, title: info.name } : t));
  });
  session.on('state', (st) => {
    if (st === 'connected' && session.host) {
      upsertContact({ id, name: contact?.name && contact.name !== formatId(id) ? contact.name : session.host.name, pk: session.host.publicKey, platform: session.host.platform, lastConnected: Date.now() });
    }
  });
  session.on('closed', ({ reason }) => {
    if (reason === 'bad-password' && savedPassword(id)) rememberPassword(id, null);
  });
  const key = `t-${randomId(6)}`;
  batch(() => {
    tabs.value = [...tabs.value, { key, hostId: id, session, title: contact?.name ?? formatId(id) }];
    activeTab.value = key;
  });
  void session.start();
  return key;
}

export function reconnect(key: string, opts: ConnectOptions = {}): void {
  const tab = tabs.value.find((t) => t.key === key);
  if (!tab) return;
  closeTab(key);
  connect(tab.hostId, { viewOnly: tab.session.viewOnly, ...opts });
}

export function closeTab(key: string): void {
  const tab = tabs.value.find((t) => t.key === key);
  if (!tab) return;
  tab.session.close('local');
  batch(() => {
    tabs.value = tabs.value.filter((t) => t.key !== key);
    if (activeTab.value === key) activeTab.value = tabs.value[tabs.value.length - 1]?.key ?? 'home';
  });
}

export function dismissInvite(from: string): void {
  invites.value = invites.value.filter((i) => i.from !== from);
}

// ------------------------------------------------------------------ links

// Links carry a 128-bit hash of this device's key, so whoever opens one connects to exactly this
// device, even on a first connection through an untrusted server.
export function inviteLink(includePassword: boolean): string {
  const base = serverUrls.value?.http ?? '';
  const pw = includePassword && settings.value.oneTimePassword && otp.value ? `&p=${encodeURIComponent(otp.value)}` : '';
  return `${base}/#c=${myId.value}${pw}&k=${keyHash(myPublicKey.value)}`;
}

export function helpLink(): string {
  const base = serverUrls.value?.http ?? '';
  return `${base}/#help=${myId.value}&n=${encodeURIComponent(settings.value.deviceName)}&k=${keyHash(myPublicKey.value)}`;
}

export type Link = { type: 'connect'; id: string; password?: string; key?: string } | { type: 'help'; id: string; name?: string; key?: string };

/** A connect link waiting for the user's confirmation (links never connect on their own). */
export const pendingLink = signal<Extract<Link, { type: 'connect' }> | null>(null);

export function parseLink(raw: string): Link | null {
  let params: URLSearchParams;
  let path = '';
  try {
    if (raw.startsWith('beamdesk:')) {
      const u = new URL(raw.replace(/^beamdesk:\/*/, 'beamdesk://x/'));
      path = u.pathname;
      params = u.searchParams;
    } else {
      const hash = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : raw;
      params = new URLSearchParams(hash);
    }
  } catch {
    return null;
  }
  const seg = path.split('/').filter(Boolean);
  const k = params.get('k');
  const key = isKeyHash(k) ? k : undefined;
  const connectId = parseId(params.get('c') ?? (seg[0] === 'connect' ? seg[1] ?? '' : ''));
  if (connectId) return { type: 'connect', id: connectId, password: params.get('p')?.slice(0, 128) ?? undefined, key };
  const helpId = parseId(params.get('help') ?? (seg[0] === 'help' ? seg[1] ?? '' : ''));
  if (helpId) return { type: 'help', id: helpId, name: params.get('n')?.slice(0, 64) ?? undefined, key };
  return null;
}

export async function handleLink(raw: string): Promise<void> {
  const link = parseLink(raw);
  if (!link) return;
  platform.attention();
  if (link.type === 'connect') {
    // Any web page can open a link: always let the user confirm before dialling.
    if (link.id !== myId.value) pendingLink.value = link;
  } else if (link.id !== myId.value) {
    help.value = link.key
      ? { helperId: link.id, helperKey: link.key, helperName: link.name || formatId(link.id), status: 'idle' }
      : { helperId: link.id, helperKey: '', helperName: link.name || formatId(link.id), status: 'error', error: 'This help link is incomplete. Ask your helper to send it again.' };
  }
}

export async function confirmPendingLink(ok: boolean): Promise<void> {
  const link = pendingLink.value;
  pendingLink.value = null;
  if (!ok || !link) return;
  if (signaling && signaling.state !== 'online') await signaling.waitOnline(10_000).catch(() => undefined);
  connect(link.id, { password: link.password, expectedKeyHash: link.key });
}

/** The person who needs help shares their screen with the helper from a help link. */
export async function startHelpSession(perms: Permissions): Promise<void> {
  const h = help.value;
  if (!h || !h.helperKey || !signaling || !host) return;
  help.value = { ...h, status: 'starting' };
  try {
    await platform.host.prepareCapture?.(() => void setSharing(false));
    if (signaling.state !== 'online') await signaling.waitOnline(10_000);
    sharing.value = true;
    syncHostSettings();
    host.preapprove(h.helperId, h.helperKey, perms);
    const ok = signaling.send(h.helperId, randomId(), 'invite', { name: settings.value.deviceName, platform: platform.os });
    help.value = { ...h, status: ok ? 'waiting' : 'error', error: ok ? undefined : 'Not connected to the server.' };
  } catch (err) {
    platform.host.releasePreparedCapture?.();
    help.value = { ...h, status: 'error', error: (err as Error).name === 'NotAllowedError' ? 'Screen sharing was cancelled.' : (err as Error).message };
  }
}

export function endHelp(): void {
  if (help.value?.status === 'sharing' || help.value?.status === 'waiting') {
    host?.endAll('local');
    if (platform.kind === 'web') void setSharing(false);
  }
  help.value = null;
}

// ------------------------------------------------------------------ boot

export async function boot(): Promise<void> {
  let storedIdentity: StoredIdentity | null = null;
  try {
    storedIdentity = stored.secrets.identity ? JSON.parse(stored.secrets.identity) : null;
  } catch {
    storedIdentity = null;
  }
  const { identity: id, created } = Identity.loadOrCreate(storedIdentity);
  identity = id;
  if (created) stored.setSecret('identity', JSON.stringify(id.toStored()));
  myId.value = id.id;
  myPublicKey.value = id.publicKeyB64;
  if (settings.value.oneTimePassword) await rotateOtp();
  startSignaling();
  presenceTimer ??= setInterval(() => void refreshPresence(), 30_000);
  platform.desktop?.onDeepLink((url) => void handleLink(url));
  platform.desktop?.onSessionBarAction((a) => {
    if (a.type === 'end' && a.sid) endHostedSession(a.sid);
    else if (a.type === 'end-all') endAllHosted();
    else platform.attention();
  });
  // Links opened at startup, or later in the same tab (only the #fragment changes).
  const consumeHash = () => {
    if (location.hash.length <= 1) return;
    const hash = location.hash;
    // Remove secrets (one-time passwords) from the address bar and history entry.
    history.replaceState(null, '', location.pathname + location.search);
    void handleLink(hash);
  };
  window.addEventListener('hashchange', consumeHash);
  consumeHash();
}

/** Debug/testing hook; not used by the UI. */
export const engine = {
  get signaling() {
    return signaling;
  },
  get host() {
    return host;
  },
};
