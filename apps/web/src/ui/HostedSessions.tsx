import { useRef, useState } from 'preact/hooks';
import { Clipboard, FolderUp, MessageSquare, MousePointer2, Folder, Volume2, X } from 'lucide-preact';
import { formatId, type HostSession, type Permissions } from '@beamdesk/core';
import { endHostedSession, hosted, refreshHosted } from '../state/app.ts';
import { Button, formatDuration, useNow } from './kit.tsx';
import { ChatPanel } from './Chat.tsx';
import { TransferList } from './Transfers.tsx';
import { useEvents } from './hooks.ts';
import { platform } from '../platform/index.ts';

const PERMS: { key: keyof Permissions; label: string; icon: any }[] = [
  { key: 'control', label: 'Control', icon: MousePointer2 },
  { key: 'clipboard', label: 'Clipboard', icon: Clipboard },
  { key: 'files', label: 'Files', icon: Folder },
  { key: 'audio', label: 'Sound', icon: Volume2 },
];

function HostedRow({ s }: { s: HostSession }) {
  useEvents(s, ['perms', 'chat', 'transfers']);
  const now = useNow();
  const [chat, setChat] = useState(false);
  const [showTransfers, setShowTransfers] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const caps = platform.host.capabilities();
  const unread = s.chat.filter((m) => m.from === 'them').length;

  return (
    <li class="hosted-row">
      <div class="hosted-main">
        <span class="live-dot" aria-hidden="true" />
        <div>
          <strong>{s.viewerName}</strong>
          <div class="contact-sub">
            {formatId(s.viewerId)} · {formatDuration(now - s.startedAt)} · {s.perms.control ? 'can control this device' : 'viewing only'}
          </div>
        </div>
      </div>
      <div class="perm-chips" role="group" aria-label="Permissions">
        {PERMS.filter((p) => caps[p.key]).map(({ key, label, icon: Icon }) => (
          <button
            type="button"
            class={`chip ${s.perms[key] ? 'on' : ''}`}
            aria-pressed={s.perms[key]}
            title={`${s.perms[key] ? 'Revoke' : 'Allow'} ${label.toLowerCase()}`}
            onClick={() => {
              s.setPerms({ ...s.perms, [key]: !s.perms[key] });
              refreshHosted();
            }}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      <div class="row-actions">
        <Button size="sm" icon={<MessageSquare size={16} />} onClick={() => setChat(!chat)}>
          Chat{unread ? ` (${unread})` : ''}
        </Button>
        <Button size="sm" icon={<FolderUp size={16} />} onClick={() => fileRef.current?.click()}>
          Send file
        </Button>
        <Button size="sm" variant="danger" icon={<X size={16} />} onClick={() => endHostedSession(s.sid)} data-testid="end-hosted">
          End
        </Button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = e.currentTarget.files;
            if (files?.length) s.sendFiles(files);
            e.currentTarget.value = '';
          }}
        />
      </div>
      {chat && <ChatPanel title={s.viewerName} messages={[...s.chat]} onSend={(t) => s.sendChat(t)} onClose={() => setChat(false)} />}
      {showTransfers && <TransferList transfers={s.files.list()} files={s.files} onClose={() => setShowTransfers(false)} />}
    </li>
  );
}

export function HostedSessions() {
  if (!hosted.value.length) return null;
  return (
    <section class="card hosted-card" aria-labelledby="hosted-title">
      <header class="card-head">
        <h2 id="hosted-title">
          <span class="live-dot" aria-hidden="true" /> Someone is connected to this device
        </h2>
      </header>
      <ul class="hosted-list">
        {hosted.value.map((s) => (
          <HostedRow key={s.sid} s={s} />
        ))}
      </ul>
    </section>
  );
}
