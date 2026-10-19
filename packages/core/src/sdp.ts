/** SDP helpers: DTLS fingerprints for channel binding, codec ordering and bitrate hints. */

/** Returns the normalised DTLS fingerprints ("sha-256 AB:CD:...") found in an SDP blob. */
export function extractFingerprints(sdp: string): string[] {
  const out = new Set<string>();
  for (const m of sdp.matchAll(/^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/gm)) {
    out.add(`${m[1].toLowerCase()} ${m[2].toUpperCase()}`);
  }
  return [...out].sort();
}

/**
 * Channel identifier both peers derive independently: the sorted pair of local and remote
 * DTLS fingerprints. A MITM that terminates DTLS cannot make both sides see the same value.
 */
export function channelIdentifier(localSdp: string, remoteSdp: string): string {
  const local = extractFingerprints(localSdp);
  const remote = extractFingerprints(remoteSdp);
  if (!local.length || !remote.length) throw new Error('SDP has no DTLS fingerprint');
  return [local.join(','), remote.join(',')].sort().join('|');
}

export type CodecName = 'AV1' | 'VP9' | 'H264' | 'VP8';
export type CodecPreference = 'auto' | CodecName;
export const CODECS: CodecName[] = ['AV1', 'VP9', 'H264', 'VP8'];

/** Moves codecs of the preferred family to the front, keeping RTX/RED/FEC entries. */
export function orderCodecs<T extends { mimeType: string }>(codecs: T[], preferred: CodecName[]): T[] {
  const rank = (c: T) => {
    const name = c.mimeType.split('/')[1]?.toUpperCase() ?? '';
    const i = preferred.indexOf(name as CodecName);
    return i === -1 ? preferred.length : i;
  };
  return [...codecs].map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
}

/**
 * Adds x-google bitrate hints to the video codecs of a *remote* description before it is applied,
 * so the host's encoder starts at a useful bitrate instead of ramping up from ~300 kbps.
 */
export function addBitrateHints(sdp: string, startKbps: number, minKbps = 300): string {
  const lines = sdp.split('\r\n');
  const videoPts = new Set<string>();
  let inVideo = false;
  for (const line of lines) {
    if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
    if (!inVideo) continue;
    const m = /^a=rtpmap:(\d+) (AV1|VP9|VP8|H264)\//i.exec(line);
    if (m) videoPts.add(m[1]);
  }
  return lines
    .map((line) => {
      const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
      if (!m || !videoPts.has(m[1]) || line.includes('x-google-start-bitrate')) return line;
      return `${line};x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps}`;
    })
    .join('\r\n');
}
