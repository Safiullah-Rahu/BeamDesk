/** Tiny always-on-top window (desktop) that reminds the user someone is connected. */
import { useEffect, useState } from 'preact/hooks';
import type { DesktopSessionBarState } from '@beamdesk/core';
import { bridge } from '../platform/index.ts';

export function SessionBar() {
  const [state, setState] = useState<DesktopSessionBarState>({ sessions: [] });
  useEffect(() => bridge?.onSessionBarState(setState), []);
  const n = state.sessions.length;
  const first = state.sessions[0];
  return (
    <div class="session-bar" role="status">
      <span class="live-dot" aria-hidden="true" />
      <span class="session-bar-text" onClick={() => bridge?.sessionBarAction({ type: 'show' })}>
        {n === 0 ? 'No active session' : n === 1 ? `${first.name} is ${first.control ? 'controlling' : 'viewing'} this computer` : `${n} people are connected`}
      </span>
      {n > 0 && (
        <button class="session-bar-btn" onClick={() => bridge?.sessionBarAction({ type: 'end-all' })}>
          Disconnect
        </button>
      )}
    </div>
  );
}
