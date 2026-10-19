import type { Platform } from '@beamdesk/core';
import { Globe, Laptop, Monitor, Smartphone } from 'lucide-preact';

export function PlatformIcon({ platform, size = 20 }: { platform?: Platform; size?: number }) {
  if (platform === 'android' || platform === 'ios') return <Smartphone size={size} />;
  if (platform === 'web') return <Globe size={size} />;
  if (platform === 'macos') return <Laptop size={size} />;
  return <Monitor size={size} />;
}
