import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePointerMove, encodePointerMove, parseControlMessage, sanitizeName, seqNewer } from '../src/protocol.ts';
import { addBitrateHints, channelIdentifier, extractFingerprints, orderCodecs } from '../src/sdp.ts';
import { codeToKey, planKeyEvent, translateModifierCode, type KeyLike } from '../src/keymap.ts';
import { formatId, normalizeServerUrl, parseId } from '../src/util.ts';
import { planQuality } from '../src/quality.ts';
import { sanitizeFileName } from '../src/files.ts';

test('pointer packets round-trip and order with wrap-around', () => {
  const p = decodePointerMove(encodePointerMove(65535, 0.25, 1.5))!;
  assert.equal(p.seq, 65535);
  assert.ok(Math.abs(p.x - 0.25) < 1e-4);
  assert.equal(p.y, 1);
  assert.ok(seqNewer(0, 65535));
  assert.ok(seqNewer(10, 5));
  assert.ok(!seqNewer(5, 10));
  assert.ok(!seqNewer(5, 5));
  assert.equal(decodePointerMove(new ArrayBuffer(3)), null);
});

test('control messages are validated', () => {
  assert.deepEqual(parseControlMessage(JSON.stringify({ t: 'key', code: 'KeyA', down: true })), { t: 'key', code: 'KeyA', down: true });
  assert.equal(parseControlMessage(JSON.stringify({ t: 'btn', b: 7, down: true, x: 0, y: 0 })), null);
  assert.equal(parseControlMessage(JSON.stringify({ t: 'evil' })), null);
  assert.equal(parseControlMessage('{not json'), null);
  assert.equal(parseControlMessage(42), null);
  assert.equal(parseControlMessage(JSON.stringify({ t: 'wheel', dx: 'a', dy: 1, x: 0, y: 0 })), null);
});

test('names are stripped of spoofing characters', () => {
  assert.equal(sanitizeName('Ali\u202e\u0007 PC'), 'Ali PC');
  assert.equal(sanitizeName(''), 'Unknown device');
  assert.equal(sanitizeName('x'.repeat(200)).length, 64);
});

test('IDs format and parse', () => {
  assert.equal(formatId('123456789'), '123 456 789');
  assert.equal(parseId(' 123-456 789 '), '123456789');
  assert.equal(parseId('012345678'), null);
  assert.equal(parseId('12345'), null);
});

test('server URLs normalise', () => {
  assert.deepEqual(normalizeServerUrl('desk.example.com'), { http: 'https://desk.example.com', ws: 'wss://desk.example.com/ws' });
  assert.deepEqual(normalizeServerUrl('http://localhost:8080/'), { http: 'http://localhost:8080', ws: 'ws://localhost:8080/ws' });
  assert.deepEqual(normalizeServerUrl('wss://desk.example.com/ws'), { http: 'https://desk.example.com', ws: 'wss://desk.example.com/ws' });
  assert.deepEqual(normalizeServerUrl('localhost:8080'), { http: 'http://localhost:8080', ws: 'ws://localhost:8080/ws' });
  assert.equal(normalizeServerUrl('ftp://x'), null);
  assert.equal(normalizeServerUrl(''), null);
});

const SDP_A = 'v=0\r\na=fingerprint:sha-256 aa:bb:cc\r\nm=video 9 UDP 96\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:98 VP9/90000\r\na=fmtp:98 profile-id=0\r\na=rtpmap:99 rtx/90000\r\na=fmtp:99 apt=98\r\n';
const SDP_B = 'v=0\r\na=fingerprint:sha-256 DD:EE:FF\r\n';

test('channel identifier is symmetric', () => {
  assert.deepEqual(extractFingerprints(SDP_A), ['sha-256 AA:BB:CC']);
  assert.equal(channelIdentifier(SDP_A, SDP_B), channelIdentifier(SDP_B, SDP_A));
  assert.throws(() => channelIdentifier('v=0', SDP_B));
});

test('bitrate hints only touch video codec fmtp lines', () => {
  const out = addBitrateHints(SDP_A, 2500);
  assert.match(out, /a=fmtp:98 profile-id=0;x-google-start-bitrate=2500;x-google-min-bitrate=300/);
  assert.match(out, /a=fmtp:99 apt=98\r\n/);
});

test('codec ordering keeps stable order within ranks', () => {
  const codecs = [{ mimeType: 'video/VP8' }, { mimeType: 'video/rtx' }, { mimeType: 'video/H264' }, { mimeType: 'video/VP9' }];
  assert.deepEqual(
    orderCodecs(codecs, ['VP9', 'H264']).map((c) => c.mimeType),
    ['video/VP9', 'video/H264', 'video/VP8', 'video/rtx'],
  );
});

const key = (code: string, k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  code,
  key: k,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

test('keyboard: translate mode types text, sends shortcuts as keys', () => {
  const held = new Set<string>();
  assert.deepEqual(planKeyEvent(key('KeyA', 'a'), true, 'translate', held), { keys: [], text: 'a', preventDefault: true });
  assert.deepEqual(planKeyEvent(key('Quote', 'ü'), true, 'translate', held).text, 'ü');
  const ctrl = planKeyEvent(key('ControlLeft', 'Control', { ctrlKey: true }), true, 'translate', held);
  assert.deepEqual(ctrl.keys, [{ code: 'ControlLeft', down: true }]);
  const c = planKeyEvent(key('KeyC', 'c', { ctrlKey: true }), true, 'translate', held);
  assert.deepEqual(c.keys, [{ code: 'KeyC', down: true }]);
  assert.equal(c.text, undefined);
  const enter = planKeyEvent(key('Enter', 'Enter'), true, 'translate', held);
  assert.deepEqual(enter.keys, [{ code: 'Enter', down: true }]);
  // AltGr characters are text, not Ctrl+Alt shortcuts.
  const at = planKeyEvent(key('KeyQ', '@', { ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' }), true, 'translate', held);
  assert.equal(at.text, '@');
  // Unpaired key-up is swallowed.
  assert.deepEqual(planKeyEvent(key('KeyZ', 'z'), false, 'physical', new Set()).keys, []);
});

test('keyboard: code mapping and Cmd/Ctrl translation', () => {
  assert.equal(codeToKey('KeyQ'), 'q');
  assert.equal(codeToKey('Digit7'), '7');
  assert.equal(codeToKey('F12'), 'f12');
  assert.equal(codeToKey('Numpad5'), 'numpad_5');
  assert.equal(codeToKey('ArrowLeft'), 'left');
  assert.equal(codeToKey('Bogus'), null);
  assert.equal(translateModifierCode('MetaLeft', 'macos', 'windows', true), 'ControlLeft');
  assert.equal(translateModifierCode('ControlLeft', 'windows', 'macos', true), 'MetaLeft');
  assert.equal(translateModifierCode('MetaLeft', 'macos', 'macos', true), 'MetaLeft');
  assert.equal(translateModifierCode('MetaLeft', 'macos', 'windows', false), 'MetaLeft');
});

test('quality presets', () => {
  assert.equal(planQuality({ preset: 'speed' }, 3840).scaleResolutionDownBy, 2.4);
  assert.equal(planQuality({ preset: 'balanced' }).fps, 60);
  assert.equal(planQuality({ preset: 'custom', fps: 500, kbps: 1 }).fps, 120);
  assert.equal(planQuality({ preset: 'custom', fps: 500, kbps: 1 }).maxBitrate, 300_000);
});

test('file names are sanitised', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('C:\\Users\\x\\a<b>.txt'), 'a_b_.txt');
  assert.equal(sanitizeFileName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFileName('...'), 'file');
  assert.equal(sanitizeFileName('a'.repeat(300) + '.pdf').length, 255);
  assert.ok(sanitizeFileName('a'.repeat(300) + '.pdf').endsWith('.pdf'));
});

test('embedded ICE candidates are split out of SDP (so the host gate cannot be bypassed)', async () => {
  const { splitCandidates, fingerprintKey } = await import('../src/sdp.ts');
  const sdp = [
    'v=0',
    'a=fingerprint:sha-256 AA:BB',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=candidate:1 1 udp 2122260223 203.0.113.7 50000 typ host',
    'a=mid:0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=mid:1',
    'a=candidate:2 1 udp 2122260223 203.0.113.7 50001 typ host',
    'a=end-of-candidates',
    '',
  ].join('\r\n');
  const { sdp: clean, candidates } = splitCandidates(sdp);
  assert.ok(!clean.includes('a=candidate'));
  assert.ok(!clean.includes('end-of-candidates'));
  assert.ok(clean.endsWith('\r\n'));
  assert.deepEqual(candidates.map((c) => [c.sdpMid, c.sdpMLineIndex]), [['0', 0], ['1', 1]]);
  assert.match(candidates[0].candidate!, /^candidate:1 /);
  assert.equal(fingerprintKey(clean), fingerprintKey(sdp));
});
