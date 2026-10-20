/**
 * Settings → Network: which BeamDesk server this device uses.
 *
 *  - a server address (public, self-hosted, or a free Render server),
 *  - a home server joined with a connection code (desktop app),
 *  - host mode: this computer is the server (desktop app),
 *
 * with step-by-step guides for Tailscale, Render and manual port forwarding.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { CheckCircle2, CircleAlert, CircleDashed, ExternalLink, House, Laptop, Server } from 'lucide-preact';
import { decodeJoinCode, shortFingerprint, type HomeAddressKind, type HostModeInfo } from '@beamdesk/core';
import { platform } from '../platform/index.ts';
import {
  engine,
  homeServer,
  hostMode,
  joinHomeServer,
  leaveHomeServer,
  pendingJoin,
  regenerateHostCode,
  serverState,
  serverTarget,
  serverUrls,
  setHostMode,
  settings,
  toast,
  updateSettings,
} from '../state/app.ts';
import { Button, CopyButton, Segmented, Spinner, Switch } from './kit.tsx';

type View = 'server' | 'home' | 'host';

const RENDER_DEPLOY = 'https://render.com/deploy?repo=https://github.com/Safiullah-Rahu/BeamDesk';
const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';

const KIND_LABEL: Record<HomeAddressKind, string> = { lan: 'Home network', tailscale: 'Tailscale', internet: 'Internet', name: 'Internet (name)' };

function InUse({ on }: { on: boolean }) {
  return on ? <span class="tag-inuse">In use</span> : null;
}

function Ext({ href, children }: { href: string; children: string }) {
  return (
    <button type="button" class="link ext" onClick={() => platform.openExternal(href)}>
      {children} <ExternalLink size={13} />
    </button>
  );
}

export function NetworkSection() {
  const desktop = !!platform.desktop;
  const current: View = serverTarget.value?.kind ?? 'server';
  const [view, setView] = useState<View>(pendingJoin.value ? 'home' : current);
  const s = settings.value;
  return (
    <>
      <h3>How this device connects</h3>
      <p class="hint">
        BeamDesk needs one server that introduces your devices to each other. Your screen and files never pass through it: they go straight between the devices, end-to-end encrypted.
      </p>
      {desktop && (
        <Segmented
          label="Server"
          value={view}
          onChange={setView}
          options={[
            { value: 'server', label: 'Server address' },
            { value: 'home', label: 'Connection code' },
            { value: 'host', label: 'This computer is the server' },
          ]}
        />
      )}
      {view === 'server' && <ServerPanel />}
      {view === 'home' && desktop && <HomePanel />}
      {view === 'host' && desktop && <HostPanel />}

      <h3>Privacy</h3>
      <Switch
        label="Always relay connections (hide my IP address)"
        hint="Routes traffic through the server's relay so the other side never sees your IP. Slightly slower; needs a relay (host mode has one built in)."
        checked={s.forceRelay}
        onChange={(v) => updateSettings({ forceRelay: v })}
      />

      <h3>Guides</h3>
      <Guides />
    </>
  );
}

// ------------------------------------------------------------------ server address

function ServerPanel() {
  const s = settings.value;
  const [url, setUrl] = useState(s.serverUrl);
  const [key, setKey] = useState(s.accessKey);
  const [info, setInfo] = useState<{ name: string; version: string; turn: boolean; requiresKey: boolean } | null | 'error'>(null);
  const inUse = serverTarget.value?.kind === 'server';
  const base = inUse ? serverUrls.value?.http : undefined;
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
  }, [base, serverState.value === 'online']);
  const dirty = url !== s.serverUrl || key !== s.accessKey || !inUse;
  return (
    <div class="panel">
      <div class="panel-head">
        <Server size={18} /> <strong>A BeamDesk server on the internet</strong> <InUse on={inUse} />
      </div>
      <label class="field">
        <span class="field-label">Server address</span>
        <input class="input" placeholder={platform.defaultServer || 'desk.example.com'} value={url} onInput={(e) => setUrl(e.currentTarget.value)} spellcheck={false} />
        <span class="hint">
          {platform.defaultServer ? (
            <>
              Leave empty to use <code>{platform.defaultServer}</code>.{' '}
            </>
          ) : null}
          Your own server, or a free one on Render (see the guide below).
        </span>
      </label>
      <label class="field">
        <span class="field-label">Access key</span>
        <input class="input" type="password" placeholder="Only for private servers" value={key} onInput={(e) => setKey(e.currentTarget.value)} />
      </label>
      <Button
        variant="primary"
        disabled={!dirty || !!hostMode.value?.config.enabled}
        onClick={() => updateSettings({ serverUrl: url.trim(), accessKey: key.trim(), connection: 'server' })}
      >
        {inUse ? 'Save and reconnect' : 'Use this server'}
      </Button>
      {hostMode.value?.config.enabled && <p class="hint">Host mode is on: this computer uses its own server. Turn host mode off to use another one.</p>}
      {inUse && info && (
        <p class="hint">
          {info === 'error'
            ? 'Could not reach the server.'
            : `${info.name} ${info.version} · ${info.turn ? 'relay (TURN) available' : 'no relay configured — very strict networks may fail'}${info.requiresKey ? ' · private' : ''}`}
        </p>
      )}
      {platform.kind === 'web' && (
        <p class="hint">
          Someone runs BeamDesk in host mode? Open the address they gave you (<code>https://…:41443</code>) in this browser instead. The browser warns about the certificate the first time: that is expected for a home server.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ connection code

function HomePanel() {
  const [code, setCode] = useState(pendingJoin.value ?? '');
  const home = homeServer.value;
  const inUse = serverTarget.value?.kind === 'home';
  const preview = code.trim() ? decodeJoinCode(code) : null;
  const online = inUse && serverState.value === 'online';
  const via = online ? engine.signaling?.url : '';
  const viaKind = home?.addresses.find((a) => via?.includes(`//${a.host}:`))?.kind;
  useEffect(() => () => void (pendingJoin.value = null), []);
  const join = () => {
    if (!joinHomeServer(code)) return toast('That is not a valid connection code. Copy it again from the computer in host mode.', 'warn');
    pendingJoin.value = null;
    setCode('');
    toast(`Joined ${decodeJoinCode(code)?.name || 'the home server'}`, 'success');
  };
  return (
    <div class="panel">
      <div class="panel-head">
        <House size={18} /> <strong>A home server (another computer in host mode)</strong> <InUse on={inUse} />
      </div>
      {home && (
        <div class="home-server">
          <div>
            <strong>{home.name || 'Home server'}</strong>{' '}
            {inUse && (online ? <span class="muted">· connected{viaKind ? ` via ${KIND_LABEL[viaKind].toLowerCase()}` : ''}</span> : <span class="muted">· {serverState.value === 'connecting' ? 'connecting…' : 'not reachable right now'}</span>)}
          </div>
          <ul class="addr-list">
            {home.addresses.map((a) => (
              <li>
                <span class="muted">{KIND_LABEL[a.kind]}</span> <code>{a.host}:{a.port}</code>
              </li>
            ))}
          </ul>
          <p class="hint">
            Certificate <code>{shortFingerprint(home.fingerprint)}</code> — BeamDesk only talks to the server with exactly this certificate.
          </p>
          <div class="inline-row">
            {!inUse && !hostMode.value?.config.enabled && (
              <Button variant="primary" size="sm" onClick={() => updateSettings({ connection: 'home' })}>
                Use this server
              </Button>
            )}
            <Button size="sm" variant="danger" onClick={leaveHomeServer}>
              Forget this server
            </Button>
          </div>
        </div>
      )}
      <label class="field">
        <span class="field-label">{home ? 'Join another home server' : 'Connection code'}</span>
        <textarea class="input code-input" rows={3} placeholder="BD1-…" value={code} onInput={(e) => setCode(e.currentTarget.value)} spellcheck={false} data-testid="join-code" />
        <span class="hint">
          {preview
            ? `${preview.name || 'Home server'} · ${preview.addresses.map((a) => KIND_LABEL[a.kind].toLowerCase()).join(', ')} · certificate ${shortFingerprint(preview.fingerprint)}`
            : 'On the computer in host mode: Settings → Network → This computer is the server → copy the code. Paste it here.'}
        </span>
      </label>
      <Button variant="primary" disabled={!preview || !!hostMode.value?.config.enabled} onClick={join} data-testid="join">
        Join
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ host mode

function Check({ state, children }: { state: 'ok' | 'bad' | 'wait' | 'off'; children: ComponentChildren }) {
  const icon = state === 'ok' ? <CheckCircle2 size={18} /> : state === 'bad' ? <CircleAlert size={18} /> : state === 'wait' ? <Spinner size={16} /> : <CircleDashed size={18} />;
  return (
    <li class={`net-check ${state}`}>
      {icon}
      <span>{children}</span>
    </li>
  );
}

function InternetCheck({ info }: { info: HostModeInfo }) {
  const st = info.status!;
  const net = st.internet;
  const where = net.externalIp ? `${net.externalIp}:${net.externalPort}` : '';
  if (st.publicHost && net.reachable === 'yes') return <Check state="ok">Internet: reachable at <code>{st.publicHost}:{net.externalPort}</code></Check>;
  if (net.behindCgnat) {
    return (
      <Check state="bad">
        Internet: not possible on this connection. Your internet provider shares one address between several customers (carrier-grade NAT), so nothing can reach this computer from outside. Use Tailscale instead (see the guide).
      </Check>
    );
  }
  if (net.mapping === 'pending') return <Check state="wait">Internet: asking your router to open port {st.port}…</Check>;
  if (net.reachable === 'checking') return <Check state="wait">Internet: checking {where}…</Check>;
  if (net.reachable === 'yes') return <Check state="ok">Internet: reachable at <code>{where}</code>{net.mapping === 'upnp' || net.mapping === 'nat-pmp' ? ' (port opened on your router automatically)' : ''}</Check>;
  if (net.mapping === 'upnp' || net.mapping === 'nat-pmp') {
    return (
      <Check state="ok">
        Internet: your router opened the port{where ? <> — <code>{where}</code></> : ''}. Many routers cannot test this from inside the home, so try it once from a phone on mobile data.
      </Check>
    );
  }
  if (net.mapping === 'failed') {
    return (
      <Check state="bad">
        Internet: your router did not open the port ({net.mappingError}). Turn on UPnP in the router settings, forward the port by hand, or use Tailscale — see the guides.
      </Check>
    );
  }
  return <Check state="off">Internet: automatic port opening is off. Forward port {st.port} (TCP and UDP) on your router by hand, or use Tailscale.</Check>;
}

/** The address browsers use, with the access key in the #fragment (never sent over the network). */
const browserLink = (info: HostModeInfo) => `${info.status?.browserUrls.at(-1) ?? ''}/#key=${info.accessKey ?? ''}`;

function HostPanel() {
  const info = hostMode.value;
  const s = settings.value;
  const [port, setPort] = useState(String(info?.config.port ?? 41443));
  const [publicHost, setPublicHost] = useState(info?.config.publicHost ?? '');
  const [busy, setBusy] = useState(false);
  if (!info) return null;
  const cfg = info.config;
  const st = info.status;
  const run = async (patch: Parameters<typeof setHostMode>[0]) => {
    setBusy(true);
    try {
      await setHostMode(patch);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="panel">
      <div class="panel-head">
        <Laptop size={18} /> <strong>Host mode: this computer is the server</strong> <InUse on={serverTarget.value?.kind === 'host'} />
      </div>
      <Switch
        label="Host mode"
        hint="Your other devices connect through this computer, from home or from anywhere. No outside service is involved. Leave this computer switched on."
        checked={cfg.enabled}
        disabled={busy}
        onChange={(v) => void run({ enabled: v })}
      />
      {!platform.desktop?.secureStorage && cfg.enabled && (
        <p class="notice">This computer has no keychain: the server's private key is stored unencrypted in your user folder.</p>
      )}
      {cfg.enabled && info.phase === 'starting' && (
        <p class="hint">
          <Spinner size={14} /> Starting the server…
        </p>
      )}
      {cfg.enabled && info.phase === 'error' && (
        <div class="notice notice-err">
          <CircleAlert size={18} />
          <span>{info.error}</span>
          <Button size="sm" onClick={() => void run({ enabled: true })}>
            Try again
          </Button>
        </div>
      )}
      {cfg.enabled && info.phase === 'running' && st && (
        <>
          <div class="field">
            <span class="field-label">Connection code for your other devices</span>
            <div class="code-box">
              <code data-testid="host-code">{st.code}</code>
              <CopyButton text={st.code} label="Copy connection code" what="Connection code copied" />
            </div>
            <span class="hint">
              {st.internet.mapping === 'pending' && <strong>Still asking your router — the code gets your internet address in a moment. </strong>}
              On each of your other computers: BeamDesk → Settings → Network → <strong>Connection code</strong> → paste → <strong>Join</strong>. Keep the code private: it is the key to your server. Certificate <code>{shortFingerprint(st.fingerprint)}</code>.
            </span>
          </div>
          <ul class="net-checks" aria-label="Where this server can be reached">
            <Check state={st.lan ? 'ok' : 'off'}>
              Home network: {st.lan ? <code>{st.lan}:{st.port}</code> : 'not connected to a home network'}
            </Check>
            <Check state={st.tailscale ? 'ok' : 'off'}>
              Tailscale: {st.tailscale ? <><code>{st.tailscale}:{st.port}</code> — works from anywhere, no router setup</> : 'not installed (optional, see the guide)'}
            </Check>
            <InternetCheck info={info} />
          </ul>
          <p class="hint">
            {st.devices} device{st.devices === 1 ? '' : 's'} connected to this server (this one included).{' '}
            <button type="button" class="link" onClick={() => platform.desktop?.hostMode.refresh()}>
              Check again
            </button>
          </p>
          <div class="field">
            <span class="field-label">Link for phones and browsers</span>
            <div class="code-box">
              <code data-testid="browser-link">{browserLink(info)}</code>
              <CopyButton text={browserLink(info)} label="Copy browser link" what="Browser link copied" />
            </div>
            <span class="hint">
              For devices without the app. Also private: it contains the key. The browser warns about the certificate the first time — expected for a home server; continue if the certificate starts with <code>{shortFingerprint(st.fingerprint).slice(0, 9)}</code>.
            </span>
          </div>
        </>
      )}
      {cfg.enabled && (
        <>
          <Switch
            label="Start with this computer"
            hint="BeamDesk opens when you sign in and turns the server back on by itself. Without this, the server is off until you open BeamDesk."
            checked={s.launchAtLogin}
            onChange={(v) => updateSettings({ launchAtLogin: v })}
          />
          <Switch label="Keep this computer awake while hosting" hint="Sleep would disconnect everyone. The screen can still turn off." checked={cfg.keepAwake} onChange={(v) => void run({ keepAwake: v })} />
          <Switch
            label="Open the port on my router automatically"
            hint="Uses UPnP or NAT-PMP, like games and video calls do. The port is closed again when host mode is turned off."
            checked={cfg.portMapping}
            disabled={busy}
            onChange={(v) => void run({ portMapping: v })}
          />
          <details class="advanced">
            <summary>Advanced</summary>
            <label class="field">
              <span class="field-label">Port (TCP and UDP)</span>
              <div class="inline-row">
                <input class="input narrow" inputMode="numeric" value={port} onInput={(e) => setPort(e.currentTarget.value.replace(/\D/g, '').slice(0, 5))} />
                <Button size="sm" disabled={busy || Number(port) === cfg.port || Number(port) < 1024 || Number(port) > 65535} onClick={() => void run({ port: Number(port) })}>
                  Apply
                </Button>
              </div>
              <span class="hint">1024–65535. Changing it changes the connection code.</span>
            </label>
            <label class="field">
              <span class="field-label">Internet name (optional)</span>
              <div class="inline-row">
                <input class="input" placeholder="myhome.duckdns.org" value={publicHost} onInput={(e) => setPublicHost(e.currentTarget.value.trim())} spellcheck={false} />
                <Button size="sm" disabled={busy || publicHost === cfg.publicHost} onClick={() => void run({ publicHost })}>
                  Apply
                </Button>
              </div>
              <span class="hint">Most home internet addresses change now and then, which changes the code. A free dynamic DNS name that follows your address keeps the code the same.</span>
            </label>
            <div class="field">
              <span class="field-label">Connection code</span>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => {
                  if (confirm('Make a new connection code? Every device has to join again with the new code; the old one stops working.')) void regenerateHostCode();
                }}
              >
                Make a new code
              </Button>
              <span class="hint">Do this if the code got into the wrong hands.</span>
            </div>
          </details>
          {platform.os === 'windows' && <p class="hint">If Windows asks whether BeamDesk may use the network, allow it (private networks is enough at home).</p>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ guides

function Guides() {
  const port = hostMode.value?.config.port ?? 41443;
  const lan = hostMode.value?.status?.lan;
  return (
    <div class="guides">
      <details>
        <summary>Reach your computer from anywhere with Tailscale (easiest, no router setup)</summary>
        <ol>
          <li>
            Install Tailscale on this computer and on every device you connect from: <Ext href={TAILSCALE_DOWNLOAD}>tailscale.com/download</Ext> (free for personal use).
          </li>
          <li>Sign in to Tailscale with the same account on all of them.</li>
          <li>
            Here, choose <strong>This computer is the server</strong> and turn on <strong>Host mode</strong>. BeamDesk finds the Tailscale address (100.x.y.z) and puts it into the connection code by itself.
          </li>
          <li>
            On the other devices: <strong>Connection code</strong> → paste → <strong>Join</strong>. They connect through Tailscale wherever they are, even on networks where port forwarding is impossible.
          </li>
        </ol>
        <p class="hint">Tailscale is a separate service that knows which of your devices exist. BeamDesk sessions stay end-to-end encrypted on top of it.</p>
      </details>
      <details>
        <summary>Use a free cloud server on Render (no computer has to stay on)</summary>
        <ol>
          <li>
            Create a free account on <Ext href="https://render.com">render.com</Ext>.
          </li>
          <li>
            Open <Ext href={RENDER_DEPLOY}>Deploy BeamDesk to Render</Ext>. Render reads the BeamDesk setup by itself.
          </li>
          <li>
            When Render asks for <code>ACCESS_KEY</code>, enter a long password of your choice (only devices that know it can use your server). Leave the <code>TURN_…</code> fields empty. Click <strong>Deploy</strong>.
          </li>
          <li>
            Wait until it says <strong>Live</strong> (about 5 minutes), then copy its address, like <code>https://beamdesk-xxxx.onrender.com</code>.
          </li>
          <li>
            On every device: <strong>Server address</strong> → paste the address, enter the access key → <strong>Use this server</strong>. Browsers can simply open the address.
          </li>
        </ol>
        <p class="hint">
          The free plan sleeps after 15 minutes without use (the first connection then takes about a minute) and has no relay for very strict networks. Fine for trying; for every day, use host mode or a paid plan.
        </p>
      </details>
      <details>
        <summary>Open the port on your router by hand</summary>
        <ol>
          <li>Open your router's settings page (its address is on the router's label, often 192.168.1.1 or 192.168.0.1) and sign in.</li>
          <li>Find “Port forwarding” (also called “Virtual server”, “NAT” or “Applications”).</li>
          <li>
            Forward port <code>{port}</code> for <strong>both TCP and UDP</strong> to this computer{lan ? <> (<code>{lan}</code>)</> : ''}.
          </li>
          <li>If the router can, “reserve” this computer's address so it does not change.</li>
          <li>
            Back here, click <strong>Check again</strong> in host mode.
          </li>
        </ol>
        <p class="hint">Not possible if your provider uses carrier-grade NAT (BeamDesk tells you). Then use Tailscale.</p>
      </details>
    </div>
  );
}
