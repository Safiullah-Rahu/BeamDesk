/**
 * Serves the web app from memory with precompressed (brotli/gzip) variants,
 * immutable caching for hashed assets and strict security headers.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface Asset {
  body: Buffer;
  br?: Buffer;
  gz?: Buffer;
  type: string;
  etag: string;
  immutable: boolean;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const COMPRESSIBLE = /^(text\/|application\/(json|manifest)|image\/svg)/;

const BASE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'display-capture=(self), clipboard-read=(self), clipboard-write=(self), fullscreen=(self), camera=(), microphone=(), geolocation=()',
};

/**
 * Security headers. Pages served over HTTPS may only talk to TLS endpoints (wss:/https:);
 * plain-HTTP pages (local testing) also need ws:/http:. HTTPS responses add HSTS.
 */
export function securityHeaders(secure: boolean): Record<string, string> {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    secure ? "connect-src 'self' wss: https:" : "connect-src 'self' ws: wss: http: https:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
  return {
    ...BASE_HEADERS,
    'Content-Security-Policy': csp,
    ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

export class StaticSite {
  private assets = new Map<string, Asset>();

  constructor(root: string | null) {
    if (root) this.load(root, root);
  }

  get enabled(): boolean {
    return this.assets.has('/index.html');
  }

  private load(root: string, dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.load(root, full);
        continue;
      }
      const rel = '/' + path.relative(root, full).split(path.sep).join('/');
      const body = fs.readFileSync(full);
      const type = TYPES[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream';
      const asset: Asset = {
        body,
        type,
        etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`,
        immutable: rel.startsWith('/assets/') && /-[A-Za-z0-9_-]{8,}\./.test(entry.name),
      };
      if (COMPRESSIBLE.test(type) && body.length > 1024) {
        asset.br = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
        asset.gz = zlib.gzipSync(body, { level: 9 });
      }
      this.assets.set(rel, asset);
    }
  }

  /** Returns true if the request was handled. */
  handle(req: IncomingMessage, res: ServerResponse, security: Record<string, string>): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      return false;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    let asset = this.assets.get(pathname);
    // Single page app fallback for extension-less routes.
    if (!asset && !path.extname(pathname)) asset = this.assets.get('/index.html');
    if (!asset) return false;

    const headers: Record<string, string> = {
      ...security,
      'Content-Type': asset.type,
      ETag: asset.etag,
      'Cache-Control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === asset.etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const accept = String(req.headers['accept-encoding'] ?? '');
    let body = asset.body;
    if (asset.br && /\bbr\b/.test(accept)) {
      body = asset.br;
      headers['Content-Encoding'] = 'br';
    } else if (asset.gz && /\bgzip\b/.test(accept)) {
      body = asset.gz;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
}
