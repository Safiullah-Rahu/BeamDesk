import { useState } from 'preact/hooks';
import { Eye, EyeOff, RefreshCw, Share2, ScreenShare, ScreenShareOff, ShieldCheck } from 'lucide-preact';
import { formatId, formatOneTimePassword } from '@beamdesk/core';
import { platform } from '../platform/index.ts';
import {
  hasPermanentPassword,
  inviteLink,
  myId,
  otp,
  reclaimConnection,
  retryServer,
  rotateOtp,
  serverError,
  serverState,
  setSharing,
  settings,
  settingsOpen,
  sharing,
} from '../state/app.ts';
import { Button, CopyButton, copyText, IconButton, Spinner } from './kit.tsx';

declare const __DOWNLOAD_URL__: string;

export function StatusPill() {
  const st = serverState.value;
  if (st === 'online') return <span class="pill ok"><span class="dot" />Ready</span>;
  if (st === 'connecting') return <span class="pill"><Spinner size={12} />Connecting…</span>;
  if (st === 'replaced')
    return (
      <span class="pill warn">
        Open in another window <button class="link" onClick={reclaimConnection}>Use here</button>
      </span>
    );
  if (st === 'error')
    return (
      <span class="pill err" title={serverError.value ?? ''}>
        Server error <button class="link" onClick={retryServer}>Retry</button>
      </span>
    );
  return <span class="pill err"><span class="dot" />Offline</span>;
}

export function DeviceCard() {
  const s = settings.value;
  const [revealed, setRevealed] = useState(true);
  const web = platform.kind === 'web';
  const accepting = sharing.value && s.access !== 'off';
  const showOtp = accepting && s.oneTimePassword && !!otp.value;

  return (
    <section class="card device-card" aria-labelledby="device-title">
      <header class="card-head">
        <h2 id="device-title">This device</h2>
        <StatusPill />
      </header>

      <div class="field-label">Your ID</div>
      <div class="big-id" data-testid="my-id">
        <span>{myId.value ? formatId(myId.value) : '··· ··· ···'}</span>
        <CopyButton text={myId.value} label="Copy ID" what="ID copied" />
      </div>

      {showOtp && (
        <>
          <div class="field-label">One-time password</div>
          <div class="otp-row">
            <span class="otp" data-testid="otp">{revealed ? formatOneTimePassword(otp.value) : '••• •••'}</span>
            <IconButton label={revealed ? 'Hide password' : 'Show password'} onClick={() => setRevealed(!revealed)}>
              {revealed ? <EyeOff size={18} /> : <Eye size={18} />}
            </IconButton>
            <IconButton label="New password" onClick={() => void rotateOtp()}>
              <RefreshCw size={18} />
            </IconButton>
            <CopyButton text={otp.value} label="Copy password" what="Password copied" />
          </div>
        </>
      )}

      {web && !sharing.value ? (
        <div class="share-cta">
          <p>Want someone to see this screen? Turn on sharing, then give them your ID.</p>
          <Button variant="primary" icon={<ScreenShare size={18} />} onClick={() => void setSharing(true)}>
            Let someone view this screen
          </Button>
        </div>
      ) : (
        <div class="row-actions">
          <Button icon={<Share2 size={18} />} onClick={() => copyText(inviteLink(true), 'Invite link copied')}>
            Copy invite link
          </Button>
          {web && (
            <Button variant="ghost" icon={<ScreenShareOff size={18} />} onClick={() => void setSharing(false)}>
              Stop sharing
            </Button>
          )}
        </div>
      )}

      {accepting && (
        <p class="hint">
          {s.access === 'password'
            ? 'People need your ID and password to connect.'
            : 'Share your ID with someone you trust. You will be asked before anyone connects.'}
          {hasPermanentPassword.value && s.unattended && ' Unattended access is on.'}
        </p>
      )}
      {!web && s.access === 'off' && (
        <p class="hint warn-text">
          Incoming connections are turned off. <button class="link" onClick={() => (settingsOpen.value = true)}>Change in Settings</button>
        </p>
      )}
      {web && sharing.value && (
        <p class="hint">
          <ShieldCheck size={14} /> In the browser, others can only <strong>view</strong> your screen.{' '}
          <a href={__DOWNLOAD_URL__} target="_blank" rel="noopener noreferrer">
            Install the desktop app
          </a>{' '}
          to allow remote control.
        </p>
      )}
    </section>
  );
}
