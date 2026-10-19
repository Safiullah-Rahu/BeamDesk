/**
 * ICE server list handed to clients. Supports coturn's "REST API" shared secret
 * (short-lived HMAC credentials, recommended), static TURN credentials, or a raw JSON override.
 */
import crypto from 'node:crypto';
import type { Config } from './config.ts';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export function iceServersFor(config: Config, deviceId: string): IceServer[] {
  if (config.iceServersJson) {
    try {
      const parsed = JSON.parse(config.iceServersJson);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through to the structured settings */
    }
  }
  const servers: IceServer[] = [];
  if (config.stunUrls.length) servers.push({ urls: config.stunUrls });
  if (config.turnUrls.length) {
    if (config.turnSecret) {
      const username = `${Math.floor(Date.now() / 1000) + config.turnTtl}:${deviceId}`;
      const credential = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
      servers.push({ urls: config.turnUrls, username, credential });
    } else if (config.turnUsername) {
      servers.push({ urls: config.turnUrls, username: config.turnUsername, credential: config.turnPassword });
    }
  }
  return servers;
}

export function hasTurn(config: Config): boolean {
  if (config.iceServersJson) return config.iceServersJson.includes('turn');
  return config.turnUrls.length > 0 && !!(config.turnSecret || config.turnUsername);
}
