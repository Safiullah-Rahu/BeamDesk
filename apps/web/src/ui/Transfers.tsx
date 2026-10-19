import { formatBytes, type FileTransfers, type Transfer } from '@beamdesk/core';
import { ArrowDown, ArrowUp, FolderOpen, X } from 'lucide-preact';
import { platform } from '../platform/index.ts';
import { IconButton } from './kit.tsx';

export function TransferList({ transfers, files, onClose }: { transfers: Transfer[]; files: FileTransfers; onClose: () => void }) {
  if (!transfers.length) return null;
  return (
    <div class="transfers" role="region" aria-label="File transfers">
      <div class="transfers-head">
        <strong>File transfers</strong>
        <button class="link small" onClick={() => files.clearFinished()}>
          Clear finished
        </button>
        <IconButton label="Hide transfers" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <ul>
        {transfers.map((t) => {
          const pct = t.size ? Math.min(100, Math.round((t.transferred / t.size) * 100)) : t.state === 'done' ? 100 : 0;
          const status =
            t.state === 'active'
              ? t.direction === 'send' && t.transferred >= t.size
                ? 'Finishing…'
                : `${pct}% · ${formatBytes(t.rate)}/s`
              : t.state === 'done'
                ? t.direction === 'send'
                  ? 'Delivered'
                  : 'Saved'
                : t.state === 'queued'
                  ? 'Waiting…'
                  : t.error || t.state;
          return (
            <li key={t.id} class={`transfer ${t.state}`}>
              <span class="transfer-icon">{t.direction === 'send' ? <ArrowUp size={16} /> : <ArrowDown size={16} />}</span>
              <div class="transfer-main">
                <div class="transfer-name" title={t.name}>
                  {t.name} <span class="muted">{formatBytes(t.size)}</span>
                </div>
                <div class="progress" aria-hidden="true">
                  <span style={{ width: `${pct}%` }} />
                </div>
                <div class="transfer-status">{status}</div>
              </div>
              {t.state === 'done' && t.location && platform.desktop && (
                <IconButton label="Show in folder" onClick={() => platform.desktop!.revealFile(t.location!)}>
                  <FolderOpen size={16} />
                </IconButton>
              )}
              {(t.state === 'active' || t.state === 'queued') && (
                <IconButton label="Cancel" onClick={() => files.cancel(t.id)}>
                  <X size={16} />
                </IconButton>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
