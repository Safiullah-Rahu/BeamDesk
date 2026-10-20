/**
 * Self-signed TLS certificates for host mode. A home computer has no domain name and no
 * certificate authority vouching for it, so instead of a CA the connection code carries the
 * SHA-256 fingerprint of this certificate and clients accept exactly that certificate (pinning).
 *
 * Node can create keys but not X.509 certificates, so the certificate is DER-encoded here.
 */
import crypto from 'node:crypto';

export interface HostCertificate {
  /** PEM private key (PKCS#8). */
  key: string;
  /** PEM certificate. */
  cert: string;
  /** base64url SHA-256 of the DER certificate: what clients pin. */
  fingerprint: string;
}

// --- minimal DER encoder -------------------------------------------------------------------

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...content: Buffer[]) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...c: Buffer[]) => tlv(0x30, ...c);
const set = (...c: Buffer[]) => tlv(0x31, ...c);
const explicit = (n: number, ...c: Buffer[]) => tlv(0xa0 | n, ...c);
const octets = (b: Buffer) => tlv(0x04, b);
const bitString = (b: Buffer) => tlv(0x03, Buffer.from([0]), b);
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));

function integer(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let v = b.subarray(i);
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]); // keep it positive
  return tlv(0x02, v);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) stack.unshift((v & 0x7f) | 0x80);
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; // YYYYMMDDHHMMSSZ
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';

/** Creates a fresh P-256 key and a self-signed certificate valid for ten years. */
export function createHostCertificate(commonName = 'BeamDesk host server'): HostCertificate {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const name = seq(set(seq(oid('2.5.4.3'), utf8(commonName.slice(0, 64)))));
  const now = Date.now();
  const extensions = explicit(
    3,
    seq(
      seq(oid('2.5.29.19'), bool(true), octets(seq())), // basicConstraints: not a CA
      seq(oid('2.5.29.15'), bool(true), octets(tlv(0x03, Buffer.from([0x07, 0x80])))), // keyUsage: digitalSignature
      seq(oid('2.5.29.37'), octets(seq(oid('1.3.6.1.5.5.7.3.1')))), // extKeyUsage: serverAuth
    ),
  );
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(crypto.randomBytes(16)),
    seq(oid(ECDSA_SHA256)),
    name,
    seq(time(new Date(now - 86_400_000)), time(new Date(now + 10 * 365 * 86_400_000))),
    name,
    publicKey.export({ format: 'der', type: 'spki' }),
    extensions,
  );
  const signature = crypto.sign('sha256', tbs, privateKey); // DER-encoded ECDSA signature
  const der = seq(tbs, seq(oid(ECDSA_SHA256)), bitString(signature));
  return {
    key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{64}/g, '$&\n').replace(/\n?$/, '\n')}-----END CERTIFICATE-----\n`,
    fingerprint: fingerprintOf(der),
  };
}

/** base64url SHA-256 of a certificate given as DER or PEM. */
export function fingerprintOf(cert: Buffer | string): string {
  const der = typeof cert === 'string' ? pemToDer(cert) : cert;
  return crypto.createHash('sha256').update(der).digest('base64url');
}

export function pemToDer(pem: string): Buffer {
  const body = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  return Buffer.from(body, 'base64');
}

/** True if key and certificate belong together and the certificate parses. */
export function certificateValid(c: Pick<HostCertificate, 'key' | 'cert'>): boolean {
  try {
    const x509 = new crypto.X509Certificate(c.cert);
    return x509.checkPrivateKey(crypto.createPrivateKey(c.key)) && x509.verify(x509.publicKey);
  } catch {
    return false;
  }
}
