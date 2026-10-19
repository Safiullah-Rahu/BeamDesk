/** Encoder tuning: quality presets and hardware-aware codec selection. */
import type { QualitySettings } from './protocol.ts';
import { CODECS, type CodecName, type CodecPreference } from './sdp.ts';

export interface EncodingPlan {
  fps: number;
  maxBitrate: number;
  scaleResolutionDownBy: number;
  contentHint: 'motion' | 'detail' | 'text';
  degradationPreference: 'maintain-framerate' | 'maintain-resolution' | 'balanced';
}

export const QUALITY_LABELS: Record<QualitySettings['preset'], string> = {
  speed: 'Fastest',
  balanced: 'Balanced',
  quality: 'Best quality',
  custom: 'Custom',
};

/**
 * Turns a preset into encoder parameters. `width` is the capture width, used so that
 * the "fastest" preset downscales very large (4K/5K) screens.
 */
export function planQuality(q: QualitySettings, width = 1920): EncodingPlan {
  switch (q.preset) {
    case 'speed':
      return {
        fps: 60,
        maxBitrate: 4_000_000,
        scaleResolutionDownBy: Math.max(1, width / 1600),
        contentHint: 'motion',
        degradationPreference: 'maintain-framerate',
      };
    case 'quality':
      return {
        fps: 30,
        maxBitrate: 25_000_000,
        scaleResolutionDownBy: 1,
        contentHint: 'text',
        degradationPreference: 'maintain-resolution',
      };
    case 'custom': {
      const fps = clamp(Math.round(q.fps ?? 30), 5, 120);
      return {
        fps,
        maxBitrate: clamp(Math.round(q.kbps ?? 8000), 300, 80_000) * 1000,
        scaleResolutionDownBy: clamp(q.scale ?? 1, 1, 4),
        contentHint: fps >= 45 ? 'motion' : 'detail',
        degradationPreference: 'balanced',
      };
    }
    case 'balanced':
    default:
      return {
        fps: 60,
        maxBitrate: 12_000_000,
        scaleResolutionDownBy: 1,
        contentHint: 'detail',
        degradationPreference: 'balanced',
      };
  }
}

const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

function sendCodecs(): Set<string> {
  try {
    const caps = RTCRtpSender.getCapabilities('video');
    return new Set((caps?.codecs ?? []).map((c) => c.mimeType.split('/')[1]?.toUpperCase() ?? ''));
  } catch {
    return new Set();
  }
}

/** Asks the browser whether a codec can be encoded with hardware acceleration. */
async function isPowerEfficient(codec: CodecName): Promise<boolean> {
  const mc = (globalThis.navigator as Navigator | undefined)?.mediaCapabilities;
  if (!mc?.encodingInfo) return false;
  try {
    const info = await mc.encodingInfo({
      type: 'webrtc',
      video: { contentType: `video/${codec}`, width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 },
    } as MediaEncodingConfiguration);
    return info.supported && info.powerEfficient;
  } catch {
    return false;
  }
}

let cachedAuto: Promise<CodecName[]> | null = null;

/**
 * Picks the codec order for the host's encoder:
 * hardware AV1 > hardware VP9 > hardware H.264 > software H.264 > VP8 > software VP9.
 * Hardware encoding keeps CPU usage (and fan noise, and battery drain) low.
 */
export function chooseCodecs(pref: CodecPreference = 'auto'): Promise<CodecName[]> {
  const available = sendCodecs();
  const has = (c: CodecName) => available.size === 0 || available.has(c);
  if (pref !== 'auto' && has(pref)) {
    return Promise.resolve([pref, ...CODECS.filter((c) => c !== pref)]);
  }
  cachedAuto ??= (async () => {
    const hw: CodecName[] = [];
    for (const c of ['AV1', 'VP9', 'H264'] as CodecName[]) {
      if (has(c) && (await isPowerEfficient(c))) hw.push(c);
    }
    const software: CodecName[] = (['H264', 'VP8', 'VP9', 'AV1'] as CodecName[]).filter((c) => has(c) && !hw.includes(c));
    return [...hw, ...software];
  })();
  return cachedAuto;
}
