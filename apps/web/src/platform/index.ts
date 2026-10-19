import type { DesktopBridge } from '@beamdesk/core';
import { createDesktopPlatform } from './desktop.ts';
import { createWebPlatform } from './web.ts';
import type { AppPlatform } from './types.ts';

declare global {
  interface Window {
    beamdesk?: DesktopBridge;
  }
}

export const platform: AppPlatform = window.beamdesk ? createDesktopPlatform(window.beamdesk) : createWebPlatform();
export const bridge: DesktopBridge | undefined = window.beamdesk;
export type { AppPlatform } from './types.ts';
