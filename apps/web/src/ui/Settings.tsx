import { useEffect, useState } from 'preact/hooks';
import { Settings as Cog, FolderOpen, Info, Network, ShieldCheck, Video, X } from 'lucide-preact';
import { APP_VERSION, formatId, keyFingerprint, type CodecPreference, type Permissions, type QualityPreset } from '@beamdesk/core';
import { platform } from '../platform/index.ts';
import {
  blocked,
  hasPermanentPassword,
  myPublicKey,
  serverUrls,
  setPermanentPassword,
  settings,
  settingsOpen,
  toast,
  trusted,
  unblock,
  untrust,
  updateSettings,
} from '../state/app.ts';
import type { Settings as S } from '../state/settings.ts';
import { Button, IconButton, Modal, Segmented, Switch } from './kit.tsx';

declare const __DOWNLOAD_URL__: string;
const REPO = 'https://github.com/Safiullah-Rahu/BeamDesk';

type Section = 'general' | 'security' | 'network' | 'video' | 'about';

export function SettingsModal() {
  const [section, setSection] = useState<Section>('general');
  if (!settingsOpen.value) return null;
  const nav: { id: Section; label: string; icon: any }[] = [
    { id: 'general', label: 'General', icon: Cog },
    { id: 'security', label: 'Security', icon: ShieldCheck },
    { id: 'network', label: 'Network', icon: Network },
    { id: 'video', label: 'Video & input', icon: Video },
    { id: 'about', label: 'About', icon: Info },
  ];
  return (
    <Modal title="Settings" wide onClose={() => (settingsOpen.value = false)}>
      <div class="settings">
        <nav class="settings-nav" aria-label="Settings sections">
          {nav.map(({ id, label, icon: Icon }) => (
            <button type="button" class={section === id ? 'on' : ''} aria-current={section === id} onClick={() => setSection(id)}>
              <Icon size={18} /> <span>{label}</span>
            </button>
          ))}
        </nav>
        <div class="settings-body">
          {section === 'general' && <General />}
          {section === 'security' && <Security />}
          {section === 'network' && <NetworkSection />}
          {section === 'video' && <VideoSection />}
          {section === 'about' && <About />}
        </div>
      </div>
    </Modal>
  );
}

const set = <K extends keyof S>(k: K) => (v: S[K]) => updateSettings({ [k]: v } as Partial<S>);

function General() {
  const s = settings.value;
  const [name, setName] = useState(s.deviceName);
  return (
    <>
      <h3>General</h3>
      <label class="field">
        <span class="field-label">Device name</span>
        <input
          class="input"
          value={name}
          maxLength={64}
          onInput={(e) => setName(e.currentTarget.value)}
          onBlur={() => name.trim() && name !== s.deviceName && updateSettings({ deviceName: name.trim() })}
        />
        <span class="hint">Shown to people you connect to.</span>
      </label>
      <div class="field">
        <span class="field-label">Appearance</span>
        <Segmented
          label="Theme"
          value={s.theme}
          onChange={set('theme')}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </div>
      {platform.desktop && (
        <>
          <Switch label="Start BeamDesk when I sign in" hint="So you can always be reached." checked={s.launchAtLogin} onChange={set('launchAtLogin')} />
          <Switch label="Keep running in the background" hint="Closing the window keeps BeamDesk in the tray/menu bar." checked={s.minimizeToTray} onChange={set('minimizeToTray')} />
        </>
      )}
      <Switch label="Sounds" hint="Play a chime for incoming requests." checked={s.sounds} onChange={set('sounds')} />
      <Switch label="Notifications" checked={s.notifications} onChange={set('notifications')} />
      {platform.desktop && <DownloadsDir />}
    </>
  );
}

function DownloadsDir() {
  const [dir, setDir] = useState(platform.desktop!.downloadsDir());
  return (
    <div class="field">
      <span class="field-label">Save received files to</span>
      <div class="inline-row">
        <code class="path">{dir}</code>
        <Button size="sm" icon={<FolderOpen size={16} />} onClick={async () => setDir((await platform.desktop!.chooseDownloadsDir()) ?? dir)}>
          Change
        </Button>
      </div>
    </div>
  );
}

function Security() {
  const s = settings.value;
  const desktop = platform.kind === 'desktop';
  const caps = platform.host.capabilities();
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const strong = pw1.length >= 10 && /[a-z]/i.test(pw1) && /\d|[^a-z0-9]/i.test(pw1);

  const savePassword = async () => {
    if (pw1.length < 8) return toast('Use at least 8 characters.', 'warn');
    if (pw1 !== pw2) return toast('The passwords do not match.', 'warn');
    await setPermanentPassword(pw1);
    updateSettings({ unattended: true });
    setPw1('');
    setPw2('');
    toast('Permanent password saved. Unattended access is on.', 'success');
  };

  const perm = (k: keyof Permissions) => (v: boolean) => updateSettings({ defaultPerms: { ...s.defaultPerms, [k]: v } });

  return (
    <>
      <h3>Who can connect to this device</h3>
      <div class="radio-cards" role="radiogroup" aria-label="Access mode">
        {([
          ['ask', 'Ask me (recommended)', 'Anyone with your ID can send a request; you click Accept. The one-time password lets people in directly.'],
          ['password', 'Password only', 'Only people who know your one-time or permanent password can connect.'],
          ['off', 'Nobody', 'Block all incoming connections. You can still connect to other devices.'],
        ] as [S['access'], string, string][]).map(([v, label, hint]) => (
          <label class={`radio-card ${s.access === v ? 'on' : ''}`}>
            <input type="radio" name="access" checked={s.access === v} onChange={() => updateSettings({ access: v })} />
            <span>
              <strong>{label}</strong>
              <span class="hint">{hint}</span>
            </span>
          </label>
        ))}
      </div>

      <h3>One-time password</h3>
      <Switch label="Use a one-time password" hint="A short password shown on this device that you can read out to your helper." checked={s.oneTimePassword} onChange={set('oneTimePassword')} />
      {s.oneTimePassword && (
        <>
          <div class="field">
            <span class="field-label">Length</span>
            <Segmented
              label="Password length"
              value={String(s.otpLength)}
              onChange={(v) => updateSettings({ otpLength: Number(v) })}
              options={[
                { value: '6', label: '6' },
                { value: '8', label: '8' },
                { value: '10', label: '10' },
              ]}
            />
          </div>
          <Switch label="New password after each use" hint="A password lets one person in once, then a new one is made." checked={s.otpRotate === 'session'} onChange={(v) => updateSettings({ otpRotate: v ? 'session' : 'manual' })} />
          <Switch label="Ask me even if the password is correct" checked={s.askEvenWithPassword} onChange={set('askEvenWithPassword')} />
        </>
      )}

      {desktop && (
        <>
          <h3>Unattended access</h3>
          <p class="hint">Connect to this computer when nobody is in front of it (for example your own office PC), using a permanent password.</p>
          <Switch
            label="Allow unattended access"
            checked={s.unattended && hasPermanentPassword.value}
            disabled={!hasPermanentPassword.value}
            hint={hasPermanentPassword.value ? undefined : 'Set a permanent password below first.'}
            onChange={set('unattended')}
          />
          <div class="password-grid">
            <input class="input" type="password" autoComplete="new-password" placeholder={hasPermanentPassword.value ? 'New permanent password' : 'Permanent password'} value={pw1} onInput={(e) => setPw1(e.currentTarget.value)} aria-label="Permanent password" />
            <input class="input" type="password" autoComplete="new-password" placeholder="Repeat password" value={pw2} onInput={(e) => setPw2(e.currentTarget.value)} aria-label="Repeat password" />
            <Button variant="primary" onClick={savePassword} disabled={!pw1}>
              {hasPermanentPassword.value ? 'Change' : 'Set password'}
            </Button>
            {hasPermanentPassword.value && (
              <Button variant="ghost" onClick={() => void setPermanentPassword(null).then(() => updateSettings({ unattended: false }))}>
                Remove
              </Button>
            )}
          </div>
          {pw1 && <p class={`hint ${strong ? 'ok-text' : 'warn-text'}`}>{strong ? 'Strong password.' : 'Tip: use 10+ characters with letters and numbers or symbols.'}</p>}
        </>
      )}

      <h3>Default permissions</h3>
      <p class="hint">What a person can do after you accept. You can change it for each session.</p>
      {caps.control && <Switch label="Control mouse and keyboard" checked={s.defaultPerms.control} onChange={perm('control')} />}
      {caps.clipboard && <Switch label="Share clipboard" checked={s.defaultPerms.clipboard} onChange={perm('clipboard')} />}
      <Switch label="Send and receive files" checked={s.defaultPerms.files} onChange={perm('files')} />
      {caps.audio && <Switch label="Share computer sound" checked={s.defaultPerms.audio} onChange={perm('audio')} />}

      <h3>Sessions</h3>
      <div class="field">
        <span class="field-label">People connected at the same time</span>
        <Segmented
          label="Maximum sessions"
          value={String(s.maxSessions)}
          onChange={(v) => updateSettings({ maxSessions: Number(v) })}
          options={['1', '2', '3', '5'].map((v) => ({ value: v, label: v }))}
        />
      </div>
      {desktop && <Switch label="Lock this computer when a session ends" hint="Recommended for unattended access." checked={s.lockOnEnd} onChange={set('lockOnEnd')} />}

      <h3>Trusted devices</h3>
      <Switch label="Trusted devices connect without asking" checked={s.trustedAutoAccept} onChange={set('trustedAutoAccept')} />
      {trusted.value.length === 0 ? (
        <p class="empty">No trusted devices. Tick “Always allow this device” when accepting a request.</p>
      ) : (
        <ul class="simple-list">
          {trusted.value.map((t) => (
            <li key={t.id}>
              <span>
                <strong>{t.name}</strong> <span class="muted">{formatId(t.id)} · key {keyFingerprint(t.pk)}</span>
              </span>
              <IconButton label="Remove" onClick={() => untrust(t.id)}>
                <X size={16} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <h3>Blocked devices</h3>
      {blocked.value.length === 0 ? (
        <p class="empty">No blocked devices.</p>
      ) : (
        <ul class="simple-list">
          {blocked.value.map((b) => (
            <li key={b.id}>
              <span>
                <strong>{b.name}</strong> <span class="muted">{formatId(b.id)}</span>
              </span>
              <Button size="sm" onClick={() => unblock(b.id)}>
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p class="hint">
        This device’s security key: <code>{keyFingerprint(myPublicKey.value)}</code>
      </p>
    </>
  );
}

function NetworkSection() {
  const s = settings.value;
  const [url, setUrl] = useState(s.serverUrl);
  const [key, setKey] = useState(s.accessKey);
  const [info, setInfo] = useState<{ name: string; version: string; turn: boolean; requiresKey: boolean } | null | 'error'>(null);
  const base = serverUrls.value?.http;
  useEffect(() => {
    if (!base) return;
    let alive = true;
    fetch(`${base}/api/info`)
      .then((r) => r.json())
      .then((j) => alive && setInfo(j))
      .catch(() => alive && setInfo('error'));
    return () => {
      alive = false;
    };
  }, [base]);
  return (
    <>
      <h3>Server</h3>
      <label class="field">
        <span class="field-label">Server address</span>
        <input class="input" placeholder={platform.defaultServer || 'desk.example.com'} value={url} onInput={(e) => setUrl(e.currentTarget.value)} spellcheck={false} />
        <span class="hint">Leave empty to use {platform.defaultServer ? <code>{platform.defaultServer}</code> : 'the default server'}. Self-host your own in minutes — see the guide.</span>
      </label>
      <label class="field">
        <span class="field-label">Access key</span>
        <input class="input" type="password" placeholder="Only for private servers" value={key} onInput={(e) => setKey(e.currentTarget.value)} />
      </label>
      <Button variant="primary" disabled={url === s.serverUrl && key === s.accessKey} onClick={() => updateSettings({ serverUrl: url.trim(), accessKey: key.trim() })}>
        Save and reconnect
      </Button>
      {info && (
        <p class="hint">
          {info === 'error'
            ? 'Could not reach the server.'
            : `${info.name} ${info.version} · ${info.turn ? 'relay (TURN) available' : 'no relay configured — very strict networks may fail'}${info.requiresKey ? ' · private' : ''}`}
        </p>
      )}
      <h3>Privacy</h3>
      <Switch
        label="Always relay connections (hide my IP address)"
        hint="Routes traffic through the server's TURN relay so the other side never sees your IP. Slightly slower; requires a TURN server."
        checked={s.forceRelay}
        onChange={set('forceRelay')}
      />
    </>
  );
}

function VideoSection() {
  const s = settings.value;
  const q = s.quality;
  const setQ = (patch: Partial<S['quality']>) => updateSettings({ quality: { ...q, ...patch } });
  return (
    <>
      <h3>Quality</h3>
      <Segmented
        label="Default quality"
        value={q.preset}
        onChange={(v: QualityPreset) => setQ({ preset: v })}
        options={[
          { value: 'speed', label: 'Fastest' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'quality', label: 'Best quality' },
          { value: 'custom', label: 'Custom' },
        ]}
      />
      <p class="hint">Fastest favours smoothness on slow networks, Best quality favours crisp text. Balanced adapts automatically.</p>
      {q.preset === 'custom' && (
        <div class="sliders">
          <label>
            Frame rate <strong>{q.fps ?? 30} fps</strong>
            <input type="range" min={5} max={120} step={5} value={q.fps ?? 30} onInput={(e) => setQ({ fps: Number(e.currentTarget.value) })} />
          </label>
          <label>
            Max bitrate <strong>{((q.kbps ?? 8000) / 1000).toFixed(1)} Mbps</strong>
            <input type="range" min={500} max={50000} step={500} value={q.kbps ?? 8000} onInput={(e) => setQ({ kbps: Number(e.currentTarget.value) })} />
          </label>
          <label>
            Resolution <strong>{q.scale && q.scale > 1 ? `1/${q.scale}` : 'Full'}</strong>
            <input type="range" min={1} max={4} step={0.5} value={q.scale ?? 1} onInput={(e) => setQ({ scale: Number(e.currentTarget.value) })} />
          </label>
        </div>
      )}
      <label class="field">
        <span class="field-label">Video codec</span>
        <select class="input" value={s.codec} onChange={(e) => updateSettings({ codec: e.currentTarget.value as CodecPreference })}>
          <option value="auto">Automatic — hardware accelerated first (recommended)</option>
          <option value="AV1">AV1 — best compression</option>
          <option value="VP9">VP9 — great for text</option>
          <option value="H264">H.264 — lowest CPU on most devices</option>
          <option value="VP8">VP8 — most compatible</option>
        </select>
      </label>
      <Segmented
        label="Default size"
        value={s.scaleMode}
        onChange={set('scaleMode')}
        options={[
          { value: 'fit', label: 'Fit to window' },
          { value: 'original', label: 'Original size' },
          { value: 'stretch', label: 'Stretch' },
        ]}
      />
      <h3>Sound</h3>
      {platform.host.capabilities().audio && <Switch label="Share this computer's sound when allowed" checked={s.shareAudio} onChange={set('shareAudio')} />}
      <Switch label="Play sound from remote devices" checked={s.remoteAudio} onChange={set('remoteAudio')} />
      <h3>Keyboard &amp; clipboard</h3>
      <Segmented
        label="Keyboard mode"
        value={s.keyboardMode}
        onChange={set('keyboardMode')}
        options={[
          { value: 'translate', label: 'Type text (any layout)' },
          { value: 'physical', label: 'Physical keys (games)' },
        ]}
      />
      <Switch label="Swap Cmd and Ctrl between Mac and Windows/Linux" hint="So Cmd+C on a Mac becomes Ctrl+C on Windows." checked={s.swapCmdCtrl} onChange={set('swapCmdCtrl')} />
      <Switch label="Sync clipboard" hint="Copy on one device, paste on the other (text)." checked={s.syncClipboard} onChange={set('syncClipboard')} />
    </>
  );
}

function About() {
  const [latest, setLatest] = useState<string | null>(null);
  const check = async () => {
    try {
      const r = await fetch('https://api.github.com/repos/Safiullah-Rahu/BeamDesk/releases/latest');
      const j = await r.json();
      const v = String(j.tag_name ?? '').replace(/^v/, '');
      setLatest(v || 'unknown');
    } catch {
      setLatest('unknown');
    }
  };
  const version = platform.desktop?.version ?? APP_VERSION;
  return (
    <>
      <h3>BeamDesk {version}</h3>
      <p>Open-source, end-to-end encrypted remote desktop. Free for everyone, forever.</p>
      <ul class="about-list">
        <li>Video, input, chat, clipboard and files travel directly between devices, encrypted with DTLS-SRTP.</li>
        <li>Passwords never leave your device (CPace password-authenticated key exchange).</li>
        <li>Each device proves its identity with its own Ed25519 key.</li>
      </ul>
      <div class="row-actions">
        <Button onClick={() => platform.openExternal(REPO)}>Source code</Button>
        <Button onClick={() => platform.openExternal(`${REPO}/blob/main/docs/USER_GUIDE.md`)}>User guide</Button>
        <Button onClick={() => platform.openExternal(`${REPO}/issues`)}>Report a problem</Button>
        {platform.desktop && <Button onClick={check}>Check for updates</Button>}
      </div>
      {latest && (
        <p class="hint">
          {latest === 'unknown' ? 'Could not check for updates.' : latest === version ? 'You have the latest version.' : (
            <>
              Version {latest} is available.{' '}
              <button class="link" onClick={() => platform.openExternal(__DOWNLOAD_URL__)}>
                Download
              </button>
            </>
          )}
        </p>
      )}
      <p class="hint">MIT licensed.</p>
    </>
  );
}
