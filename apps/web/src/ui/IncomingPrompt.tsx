import { useState } from 'preact/hooks';
import { BadgeCheck, Clipboard, Folder, MousePointer2, ShieldAlert, Volume2 } from 'lucide-preact';
import { formatId, type IncomingRequest, type Permissions } from '@beamdesk/core';
import { platform } from '../platform/index.ts';
import { requests, settings, toast } from '../state/app.ts';
import { Button, Modal, Switch, useNow } from './kit.tsx';
import { PlatformIcon } from './PlatformIcon.tsx';
import { platformLabel } from './hooks.ts';

function Prompt({ r }: { r: IncomingRequest }) {
  const caps = platform.host.capabilities();
  const [perms, setPerms] = useState<Permissions>({ ...settings.value.defaultPerms });
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow();
  const left = Math.max(0, Math.ceil((r.expiresAt - now) / 1000));

  const accept = async () => {
    setBusy(true);
    try {
      // Browsers only show the screen picker in response to a click.
      if (platform.host.prepareCapture && !platform.host.hasPreparedCapture?.()) await platform.host.prepareCapture();
      r.accept(perms, { trust });
    } catch {
      toast('Screen sharing was cancelled, so the request was declined.', 'warn');
      r.decline();
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof Permissions) => (v: boolean) => setPerms({ ...perms, [k]: v });

  return (
    <Modal
      title="Incoming connection"
      footer={
        <>
          <button class="link danger small" onClick={() => r.decline({ block: true })}>
            Block this device
          </button>
          <span class="spacer" />
          <Button onClick={() => r.decline()} data-testid="decline">
            Decline
          </Button>
          <Button variant="primary" onClick={accept} disabled={busy} data-testid="accept">
            Accept
          </Button>
        </>
      }
    >
      <div class="request-who">
        <span class="avatar big">
          <PlatformIcon platform={r.platform} size={28} />
        </span>
        <div>
          <div class="request-name">{r.name}</div>
          <div class="contact-sub">
            {formatId(r.viewerId)} · {platformLabel(r.platform)}
          </div>
          {r.knownDevice ? (
            <span class="pill ok small">
              <BadgeCheck size={12} /> Trusted device
            </span>
          ) : (
            <span class="pill small">New device</span>
          )}
        </div>
      </div>
      <p class="request-text">
        <strong>{r.name}</strong> wants to {perms.control && caps.control ? 'see and control' : 'see'} your screen. Only accept if you know this person.
      </p>
      <div class="perm-list">
        {caps.control && <Switch label={<><MousePointer2 size={16} /> Control mouse &amp; keyboard</>} checked={perms.control} onChange={set('control')} />}
        {caps.clipboard && <Switch label={<><Clipboard size={16} /> Share clipboard</>} checked={perms.clipboard} onChange={set('clipboard')} />}
        {caps.files && <Switch label={<><Folder size={16} /> Send and receive files</>} checked={perms.files} onChange={set('files')} />}
        {caps.audio && <Switch label={<><Volume2 size={16} /> Share computer sound</>} checked={perms.audio} onChange={set('audio')} />}
      </div>
      <label class="check">
        <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.currentTarget.checked)} /> Always allow this device without asking
      </label>
      <div class="security-code">
        <ShieldAlert size={16} />
        <span>
          Security code <code>{r.securityCode}</code> — the other person sees the same code.
        </span>
      </div>
      <p class="hint">This request expires in {left}s.</p>
    </Modal>
  );
}

export function IncomingPrompts() {
  const r = requests.value[0];
  return r ? <Prompt key={r.sid} r={r} /> : null;
}
