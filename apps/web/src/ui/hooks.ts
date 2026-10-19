import { useEffect, useReducer } from 'preact/hooks';
import type { Platform } from '@beamdesk/core';

interface Subscribable {
  on(event: string, fn: (payload: any) => void): () => void;
}

/** Re-renders the component whenever the emitter fires one of `events`. */
export function useEvents(emitter: Subscribable | null | undefined, events: string[]): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!emitter) return;
    const offs = events.map((e) => emitter.on(e, () => force(0)));
    return () => offs.forEach((off) => off());
  }, [emitter]);
}

export function platformLabel(p: Platform | undefined): string {
  const map: Record<string, string> = {
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
    web: 'Web browser',
    android: 'Android',
    ios: 'iOS',
  };
  return map[p ?? ''] ?? 'Unknown';
}

export function timeAgo(ts: number): string {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
