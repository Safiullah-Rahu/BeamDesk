import { useEffect, useState } from 'preact/hooks';
import { CircleCheck, Info, LifeBuoy, MonitorUp, ScreenShare, ShieldAlert, TriangleAlert, X } from 'lucide-preact';
import { formatId, type Permissions } from '@beamdesk/core';
import { platform } from '../platform/index.ts';
import { confirmPendingLink, connect, dismissInvite, dismissToast, endHelp, help, hosted, invites, pendingLink, settingsOpen, startHelpSession, toasts } from '../state/app.ts';
import { Button, IconButton, Modal, Spinner, Switch } from './kit.tsx';
import type { DesktopPermissions } from '../platform/types.ts';

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.level}`}>
          {t.level === 'success' ? <CircleCheck size={18} /> : t.level === 'info' ? <Info size={18} /> : <TriangleAlert size={18} />}
          <span>{t.text}</span>
          {t.action && (
            <button
              class="link"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <IconButton label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

/** Helper side: someone opened our help link and is sharing their screen. */
export function InviteBanners() {
  if (!invites.value.length) return null;
  return (
    <div class="invites">
      {invites.value.map((i) => (
        <div class="invite" key={i.from} role="alert">
          <MonitorUp size={20} />
          <span>
            <strong>{i.name}</strong> ({formatId(i.from)}) is sharing their screen with you.
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              dismissInvite(i.from);
              connect(i.from);
            }}
            data-testid="join-invite"
          >
            Join now
          </Button>
          <IconButton label="Ignore" onClick={() => dismissInvite(i.from)}>
            <X size={16} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

/** Person who needs help: opened a help link (web or desktop). */
export function HelpLanding() {
  const h = help.value;
  const desktop = platform.kind === 'desktop';
  const caps = platform.host.capabilities();
  const [perms, setPerms] = useState<Permissions>({ control: desktop && caps.control, clipboard: desktop, files: true, audio: false });
  if (!h) return null;
  const viewer = hosted.value[0];

  return (
    <Modal title="Get remote help" onClose={h.status === 'sharing' ? undefined : endHelp}>
      <div class="help-landing">
        <span class="hero-icon">
          <LifeBuoy size={36} />
        </span>
        {h.status === 'sharing' ? (
          <>
            <h3>You are sharing your screen with {viewer?.viewerName ?? h.helperName}</h3>
            <p>They can {viewer?.perms.control ? 'see and control' : 'see'} your screen. You can stop at any time.</p>
            <Button variant="danger" size="lg" onClick={endHelp}>
              Stop sharing
            </Button>
          </>
        ) : h.status === 'waiting' ? (
          <>
            <Spinner size={30} />
            <h3>Waiting for {h.helperName} to join…</h3>
            <p class="hint">Keep this {desktop ? 'window' : 'tab'} open. They have been notified.</p>
            <Button onClick={endHelp}>Cancel</Button>
          </>
        ) : (
          <>
            <h3>
              <strong>{h.helperName}</strong> would like to help you
            </h3>
            <p>Click the button and choose what to share. {desktop ? '' : 'Nothing to install.'} Only continue if you know and trust this person.</p>
            {desktop && caps.control && <Switch label="Allow them to control my mouse and keyboard" checked={perms.control} onChange={(v) => setPerms({ ...perms, control: v })} />}
            {h.status === 'error' && <p class="warn-text">{h.error}</p>}
            {h.helperKey && (
              <Button variant="primary" size="lg" icon={h.status === 'starting' ? <Spinner /> : <ScreenShare size={20} />} disabled={h.status === 'starting'} onClick={() => void startHelpSession(perms)} data-testid="share-for-help">
                Share my screen
              </Button>
            )}
            <p class="hint">
              <ShieldAlert size={14} /> Helper ID: {formatId(h.helperId)}
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Links (invite links, beamdesk:// deep links) never connect without the user's confirmation. */
export function LinkConfirm() {
  const link = pendingLink.value;
  if (!link) return null;
  return (
    <Modal
      title="Connect to this device?"
      onClose={() => void confirmPendingLink(false)}
      footer={
        <>
          <span class="spacer" />
          <Button onClick={() => void confirmPendingLink(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => void confirmPendingLink(true)} data-testid="confirm-link">
            Connect
          </Button>
        </>
      }
    >
      <div class="help-landing">
        <span class="hero-icon">
          <MonitorUp size={34} />
        </span>
        <h3>{formatId(link.id)}</h3>
        <p>
          A link asks BeamDesk to connect to this device{link.password ? ' using the password it contains' : ''}. Only continue if you were expecting it.
        </p>
        {link.key && (
          <p class="hint">
            <ShieldAlert size={14} /> The link pins the device's security key, so you can only reach that exact device.
          </p>
        )}
      </div>
    </Modal>
  );
}

/** First-run hints: macOS permissions, Wayland limitations, missing server. */
export function SetupNotices() {
  const [perm, setPerm] = useState<DesktopPermissions | null>(null);
  useEffect(() => {
    if (!platform.desktop) return;
    const load = () => void platform.desktop!.permissions().then(setPerm).catch(() => undefined);
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  const items: { text: string; action?: { label: string; run: () => void } }[] = [];
  if (platform.os === 'macos' && perm) {
    if (perm.screen !== 'granted' && perm.screen !== 'unknown')
      items.push({ text: 'Allow BeamDesk to record the screen so others can see it.', action: { label: 'Open Settings', run: () => platform.desktop!.openPermissionSettings('screen') } });
    if (!perm.accessibility)
      items.push({ text: 'Allow BeamDesk to control this Mac (Accessibility) so helpers can use the mouse and keyboard.', action: { label: 'Open Settings', run: () => platform.desktop!.openPermissionSettings('accessibility') } });
  }
  if (perm?.wayland) items.push({ text: 'You are using Wayland: screen sharing works, but remote control needs an X11 session (choose “Ubuntu on Xorg” at login).' });
  if (platform.desktop && !platform.desktop.inputAvailable() && platform.os !== 'macos') items.push({ text: 'Remote control is unavailable on this system; others can still view your screen.' });
  if (!items.length) return null;
  return (
    <div class="notices">
      {items.map((i) => (
        <div class="notice" key={i.text}>
          <TriangleAlert size={18} />
          <span>{i.text}</span>
          {i.action && (
            <Button size="sm" onClick={i.action.run}>
              {i.action.label}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function NeedsServer() {
  return (
    <div class="notices">
      <div class="notice">
        <TriangleAlert size={18} />
        <span>Choose the BeamDesk server you want to use. It is the meeting point that introduces devices — your screen never passes through it.</span>
        <Button size="sm" variant="primary" onClick={() => (settingsOpen.value = true)}>
          Set server
        </Button>
      </div>
    </div>
  );
}
