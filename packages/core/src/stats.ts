/** Turns RTCStatsReport into the handful of numbers people care about. */

export interface ConnectionStats {
  /** "direct" (peer-to-peer) or "relay" (through a TURN server). */
  route: 'direct' | 'relay' | 'unknown';
  protocol: string;
  rttMs: number | null;
  fps: number;
  width: number;
  height: number;
  bitrate: number;
  codec: string;
  packetLoss: number;
  /** Average time frames spend in the jitter buffer. */
  bufferMs: number | null;
  decodeMs: number | null;
}

interface Prev {
  ts: number;
  bytes: number;
  lost: number;
  received: number;
}

export class StatsSampler {
  private prev: Prev | null = null;

  async sample(pc: RTCPeerConnection): Promise<ConnectionStats> {
    const report = await pc.getStats();
    const out: ConnectionStats = {
      route: 'unknown',
      protocol: '',
      rttMs: null,
      fps: 0,
      width: 0,
      height: 0,
      bitrate: 0,
      codec: '',
      packetLoss: 0,
      bufferMs: null,
      decodeMs: null,
    };
    let pairId: string | undefined;
    const byId = new Map<string, any>();
    report.forEach((s: any) => {
      byId.set(s.id, s);
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    });
    if (!pairId) {
      report.forEach((s: any) => {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pairId = s.id;
      });
    }
    const pair = pairId ? byId.get(pairId) : undefined;
    if (pair) {
      if (typeof pair.currentRoundTripTime === 'number') out.rttMs = Math.round(pair.currentRoundTripTime * 1000);
      const local = byId.get(pair.localCandidateId);
      const remote = byId.get(pair.remoteCandidateId);
      if (local || remote) out.route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
      out.protocol = (local?.relayProtocol || local?.protocol || '').toUpperCase();
    }
    report.forEach((s: any) => {
      if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
      out.fps = Math.round(s.framesPerSecond ?? 0);
      out.width = s.frameWidth ?? 0;
      out.height = s.frameHeight ?? 0;
      const codec = s.codecId ? byId.get(s.codecId) : undefined;
      if (codec?.mimeType) out.codec = String(codec.mimeType).split('/')[1] ?? '';
      if (s.jitterBufferEmittedCount > 0) out.bufferMs = Math.round((s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000);
      if (s.framesDecoded > 0 && typeof s.totalDecodeTime === 'number') out.decodeMs = Math.round((s.totalDecodeTime / s.framesDecoded) * 1000 * 10) / 10;
      const now = s.timestamp as number;
      const bytes = s.bytesReceived ?? 0;
      const lost = s.packetsLost ?? 0;
      const received = s.packetsReceived ?? 0;
      if (this.prev && now > this.prev.ts) {
        out.bitrate = ((bytes - this.prev.bytes) * 8 * 1000) / (now - this.prev.ts);
        const dl = lost - this.prev.lost;
        const dr = received - this.prev.received;
        out.packetLoss = dl + dr > 0 ? Math.max(0, dl / (dl + dr)) : 0;
      }
      this.prev = { ts: now, bytes, lost, received };
    });
    return out;
  }
}
