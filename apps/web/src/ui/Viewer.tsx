import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  Activity,
  Camera,
  Circle,
  CircleStop,
  Clipboard,
  Eye,
  Gauge,
  Keyboard,
  LockKeyhole,
  Maximize,
  MessageSquare,
  Minimize,
  Monitor,
  MousePointer2,
  Scaling,
  ShieldAlert,
  Upload,
  X,
} from 'lucide-preact';
import {
  formatBitrate,
  formatId,
  planKeyEvent,
  QUALITY_LABELS,
  SPECIAL_COMBOS,
  type ConnectionStats,
  type QualityPreset,
} from '@beamdesk/core';
import { platform } from '../platform/index.ts';
import { closeTab, reconnect, settings, toast, updateSettings, type Tab } from '../state/app.ts';
import type { ScaleMode } from '../state/settings.ts';
import { Button, IconButton, Menu, MenuItem, MenuLabel, MenuSep, Spinner } from './kit.tsx';
import { ChatPanel } from './Chat.tsx';
import { TransferList } from './Transfers.tsx';
import { useEvents } from './hooks.ts';
import { downloadBlob } from '../platform/web.ts';

const btn = (b: number): 0 | 1 | 2 | null => (b === 0 ? 0 : b === 1 ? 1 : b === 2 ? 2 : null);

export function Viewer({ tab, active }: { tab: Tab; active: boolean }) {
  const s = tab.session;
  useEvents(s, ['state', 'host', 'perms', 'displays', 'chat', 'transfers', 'closed']);
  const st = settings.value;
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const kbdRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [scale, setScale] = useState<ScaleMode>(st.scaleMode);
  const [chatOpen, setChatOpen] = useState(false);
  const [seen, setSeen] = useState(0);
  const [showTransfers, setShowTransfers] = useState(true);
  const [stats, setStats] = useState<ConnectionStats | null>(null);
  const [showStats, setShowStats] = useState(st.showStats);
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [password, setPassword] = useState('');
  const held = useRef(new Set<string>());
  const keyQueue = useRef<Promise<void>>(Promise.resolve());
  const enqueue = (fn: () => void | Promise<void>) => (keyQueue.current = keyQueue.current.then(fn).catch(() => undefined));

  // ---------------------------------------------------------------- media
  useEffect(() => {
    const attach = (stream: MediaStream) => {
      if (videoRef.current && videoRef.current.srcObject !== stream) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => undefined);
      }
      if (audioRef.current && audioRef.current.srcObject !== stream) {
        audioRef.current.srcObject = stream;
        void audioRef.current.play().catch(() => undefined);
      }
    };
    if (s.stream) attach(s.stream);
    const offs = [
      s.on('stream', attach),
      s.on('clipboard', (text) => {
        if (settings.value.syncClipboard) void platform.clipboard.write(text);
      }),
      s.on('notice', (n) => toast(n.text, n.level)),
      s.on('file-received', (t) => toast(`Received ${t.name}`, 'success', platform.desktop && t.location ? { label: 'Show', run: () => platform.desktop!.revealFile(t.location!) } : undefined)),
    ];
    return () => offs.forEach((o) => o());
  }, [s]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = !st.remoteAudio;
  }, [st.remoteAudio]);

  // ---------------------------------------------------------------- layout
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => setBox({ w: stage.clientWidth, h: stage.clientHeight }));
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  const onVideoResize = () => {
    const v = videoRef.current;
    if (v) setVideoSize({ w: v.videoWidth, h: v.videoHeight });
  };

  let vw = 0;
  let vh = 0;
  if (videoSize.w && box.w) {
    if (scale === 'stretch') {
      vw = box.w;
      vh = box.h;
    } else if (scale === 'original') {
      const dpr = window.devicePixelRatio || 1;
      vw = videoSize.w / dpr;
      vh = videoSize.h / dpr;
    } else {
      const k = Math.min(box.w / videoSize.w, box.h / videoSize.h);
      vw = Math.floor(videoSize.w * k);
      vh = Math.floor(videoSize.h * k);
    }
  }

  // ---------------------------------------------------------------- stats
  useEffect(() => {
    if (!showStats || !active) return;
    let stop = false;
    const tick = async () => {
      const r = await s.stats();
      if (!stop) setStats(r);
    };
    void tick();
    const t = setInterval(tick, 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [showStats, active, s]);

  // Light-weight route badge even with stats hidden.
  useEffect(() => {
    if (s.state !== 'connected' || showStats) return;
    const t = setTimeout(async () => setStats(await s.stats()), 1500);
    return () => clearTimeout(t);
  }, [s.state, showStats]);

  // ---------------------------------------------------------------- clipboard (local -> remote)
  const pushClipboard = useCallback(async () => {
    if (!settings.value.syncClipboard || !s.perms.clipboard || s.viewOnly) return;
    const text = await platform.clipboard.read();
    if (text) s.sendClipboard(text);
  }, [s]);

  useEffect(() => {
    if (!active || s.state !== 'connected') return;
    const onFocus = () => void pushClipboard();
    window.addEventListener('focus', onFocus);
    const poll = platform.kind === 'desktop' ? setInterval(onFocus, 1000) : null;
    return () => {
      window.removeEventListener('focus', onFocus);
      if (poll) clearInterval(poll);
    };
  }, [active, s.state, pushClipboard]);

  // ---------------------------------------------------------------- keyboard
  const releaseKeys = useCallback(() => {
    for (const code of held.current) s.key(code, false);
    held.current.clear();
    s.releaseAll();
  }, [s]);

  useEffect(() => {
    window.addEventListener('blur', releaseKeys);
    return () => window.removeEventListener('blur', releaseKeys);
  }, [releaseKeys]);

  useEffect(() => {
    if (active && s.state === 'connected') rootRef.current?.focus({ preventScroll: true });
    if (!active) releaseKeys();
  }, [active, s.state]);

  const onKey = (e: KeyboardEvent, down: boolean) => {
    if (!s.canControl) return;
    const plan = planKeyEvent(e, down, settings.value.keyboardMode, held.current);
    if (plan.preventDefault) e.preventDefault();
    const isPaste = down && (e.ctrlKey || e.metaKey) && e.code === 'KeyV';
    if (isPaste) enqueue(pushClipboard);
    enqueue(() => {
      for (const k of plan.keys) s.key(k.code, k.down);
      if (plan.text) s.text(plan.text);
    });
  };

  // ---------------------------------------------------------------- pointer
  const norm = (e: { clientX: number; clientY: number }) => {
    const r = videoRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const touch = useRef<{ id: number; x0: number; y0: number; t0: number; dragging: boolean; timer: any; scrollY?: number } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());

  const onPointerDown = (e: PointerEvent) => {
    rootRef.current?.focus({ preventScroll: true });
    if (!s.canControl || !videoRef.current) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = norm(e);
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2) {
        // Two fingers: scroll mode.
        if (touch.current?.dragging) s.pointerButton(0, false, p.x, p.y);
        clearTimeout(touch.current?.timer);
        touch.current = { id: -1, x0: 0, y0: 0, t0: 0, dragging: false, timer: null, scrollY: avgY() };
        return;
      }
      s.pointerMove(p.x, p.y);
      const t = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: Date.now(), dragging: false, timer: null as any };
      t.timer = setTimeout(() => {
        // Long press = right click.
        if (touch.current === t && !t.dragging) {
          s.pointerButton(2, true, p.x, p.y);
          s.pointerButton(2, false, p.x, p.y);
          touch.current = null;
          navigator.vibrate?.(15);
        }
      }, 550);
      touch.current = t;
      return;
    }
    const b = btn(e.button);
    if (b === null) return;
    s.pointerMove(p.x, p.y);
    s.pointerButton(b, true, p.x, p.y);
  };

  const avgY = () => {
    let sum = 0;
    for (const v of touches.current.values()) sum += v.y;
    return sum / Math.max(1, touches.current.size);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!s.canControl || !videoRef.current) return;
    if (e.pointerType === 'touch') {
      if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const t = touch.current;
      if (!t) return;
      if (t.scrollY !== undefined) {
        const y = avgY();
        const p = norm(e);
        s.wheel(0, (t.scrollY - y) * 2, p.x, p.y);
        t.scrollY = y;
        return;
      }
      if (t.id !== e.pointerId) return;
      const p = norm(e);
      if (!t.dragging && Math.hypot(e.clientX - t.x0, e.clientY - t.y0) > 8) {
        t.dragging = true;
        clearTimeout(t.timer);
        s.pointerButton(0, true, p.x, p.y);
      }
      if (t.dragging) s.pointerMove(p.x, p.y);
      return;
    }
    const events = (e as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] }).getCoalescedEvents?.();
    const last = events?.length ? events[events.length - 1] : e;
    const p = norm(last);
    s.pointerMove(p.x, p.y);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!s.canControl || !videoRef.current) return;
    const p = norm(e);
    if (e.pointerType === 'touch') {
      touches.current.delete(e.pointerId);
      const t = touch.current;
      if (!t) return;
      if (t.scrollY !== undefined) {
        if (touches.current.size === 0) touch.current = null;
        return;
      }
      if (t.id !== e.pointerId) return;
      clearTimeout(t.timer);
      if (t.dragging) s.pointerButton(0, false, p.x, p.y);
      else if (Date.now() - t.t0 < 550) {
        s.pointerButton(0, true, p.x, p.y);
        s.pointerButton(0, false, p.x, p.y);
      }
      touch.current = null;
      return;
    }
    const b = btn(e.button);
    if (b !== null) s.pointerButton(b, false, p.x, p.y);
  };

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!s.canControl) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      const p = norm(e);
      s.wheel(e.deltaX * k, e.deltaY * k, p.x, p.y);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [s]);

  // ---------------------------------------------------------------- fullscreen
  useEffect(() => {
    const onFs = () => {
      const on = document.fullscreenElement === rootRef.current;
      setFullscreen(on);
      const kb = (navigator as any).keyboard;
      if (on) kb?.lock?.().catch?.(() => undefined);
      else kb?.unlock?.();
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen().catch(() => toast('Fullscreen is not available here', 'warn'));
  };

  // ---------------------------------------------------------------- tools
  const screenshot = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    c.toBlob((b) => b && downloadBlob(b, `BeamDesk-${tab.hostId}-${stamp()}.png`), 'image/png');
    toast('Screenshot saved', 'success', undefined, 2000);
  };

  const toggleRecording = () => {
    if (recorder) {
      recorder.stop();
      return;
    }
    if (!s.stream || typeof MediaRecorder === 'undefined') return toast('Recording is not supported here', 'warn');
    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(s.stream, { mimeType: type, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      setRecorder(null);
      const ext = type?.includes('mp4') ? 'mp4' : 'webm';
      downloadBlob(new Blob(chunks, { type: type ?? 'video/webm' }), `BeamDesk-${tab.hostId}-${stamp()}.${ext}`);
      toast('Recording saved', 'success');
    };
    rec.start(1000);
    setRecorder(rec);
  };

  useEffect(() => () => recorder?.state === 'recording' ? recorder.stop() : undefined, [recorder]);
  useEffect(() => {
    if (s.state === 'closed' && recorder?.state === 'recording') recorder.stop();
  }, [s.state]);

  const setQuality = (preset: QualityPreset) => {
    s.setQuality({ preset });
    updateSettings({ quality: { preset } });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    if (!s.perms.files) return toast('File transfer is not allowed by the other side', 'warn');
    s.sendFiles(files);
    setShowTransfers(true);
  };

  // ---------------------------------------------------------------- render
  const host = s.host;
  const name = host?.name ?? formatId(tab.hostId);
  const connected = s.state === 'connected' || s.state === 'reconnecting';
  const unread = s.chat.filter((m) => m.from === 'them').length - seen;
  const transfers = s.files.list();
  const combos = SPECIAL_COMBOS.filter((c) => !c.hosts || c.hosts.includes(host?.platform ?? 'windows'));
  const control = s.canControl;
  const viewOnlyReason = connected && !host?.caps.control ? 'The other device shares from a browser, so it can only be viewed.' : connected && !s.perms.control ? 'The other person allowed viewing only.' : null;

  return (
    <div
      class={`viewer ${active ? '' : 'hidden'} ${fullscreen ? 'fs' : ''}`}
      ref={rootRef}
      tabIndex={0}
      onKeyDown={(e) => onKey(e, true)}
      onKeyUp={(e) => onKey(e, false)}
      data-testid="viewer"
      data-state={s.state}
    >
      {connected && (
        <div class="toolbar" role="toolbar" aria-label="Session controls" onKeyDown={(e) => e.stopPropagation()}>
          <div class="toolbar-info">
            <LockKeyhole size={14} aria-hidden="true" />
            <strong title={`${name} · ${formatId(tab.hostId)}`}>{name}</strong>
            {stats && (
              <span class={`route ${stats.route}`} title={stats.route === 'relay' ? 'Relayed through a TURN server' : 'Direct peer-to-peer connection'}>
                {stats.route === 'relay' ? 'Relay' : 'Direct'}
                {stats.rttMs !== null && ` · ${stats.rttMs} ms`}
              </span>
            )}
          </div>
          <div class="toolbar-actions">
            {s.displays.length > 1 && (
              <Menu label="Choose display" trigger={<Monitor size={18} />}>
                {(close) => (
                  <>
                    <MenuLabel>Display</MenuLabel>
                    {s.displays.map((d, i) => (
                      <MenuItem checked={d.id === s.currentDisplay} onClick={() => (close(), s.selectDisplay(d.id))}>
                        {d.name || `Display ${i + 1}`} <span class="muted">{d.width}×{d.height}</span>
                      </MenuItem>
                    ))}
                  </>
                )}
              </Menu>
            )}
            <Menu label="Quality" trigger={<Gauge size={18} />}>
              {(close) => (
                <>
                  <MenuLabel>Quality</MenuLabel>
                  {(['speed', 'balanced', 'quality'] as QualityPreset[]).map((p) => (
                    <MenuItem checked={st.quality.preset === p} onClick={() => (close(), setQuality(p))}>
                      {QUALITY_LABELS[p]}
                      <span class="muted">{p === 'speed' ? 'smooth on slow networks' : p === 'balanced' ? 'recommended' : 'sharpest text'}</span>
                    </MenuItem>
                  ))}
                  <MenuSep />
                  <MenuLabel>Size</MenuLabel>
                  {([
                    ['fit', 'Fit to window'],
                    ['original', 'Original size'],
                    ['stretch', 'Stretch'],
                  ] as [ScaleMode, string][]).map(([v, l]) => (
                    <MenuItem checked={scale === v} icon={<Scaling size={16} />} onClick={() => (close(), setScale(v), updateSettings({ scaleMode: v }))}>
                      {l}
                    </MenuItem>
                  ))}
                  <MenuSep />
                  <MenuItem checked={st.remoteAudio} onClick={() => (close(), updateSettings({ remoteAudio: !st.remoteAudio }))}>
                    Play remote sound
                  </MenuItem>
                </>
              )}
            </Menu>
            <Menu label="Keyboard" trigger={<Keyboard size={18} />}>
              {(close) => (
                <>
                  <MenuLabel>Send keys</MenuLabel>
                  {combos.map((c) => (
                    <MenuItem disabled={!control} onClick={() => (close(), s.combo(c.keys))}>
                      {c.label}
                    </MenuItem>
                  ))}
                  <MenuSep />
                  <MenuLabel>Keyboard mode</MenuLabel>
                  <MenuItem checked={st.keyboardMode === 'translate'} onClick={() => (close(), updateSettings({ keyboardMode: 'translate' }))}>
                    Type text <span class="muted">works with any layout</span>
                  </MenuItem>
                  <MenuItem checked={st.keyboardMode === 'physical'} onClick={() => (close(), updateSettings({ keyboardMode: 'physical' }))}>
                    Physical keys <span class="muted">best for games</span>
                  </MenuItem>
                  <MenuSep />
                  <MenuItem
                    icon={<Keyboard size={16} />}
                    disabled={!control}
                    onClick={() => {
                      close();
                      kbdRef.current?.focus();
                    }}
                  >
                    On-screen keyboard
                  </MenuItem>
                </>
              )}
            </Menu>
            <IconButton
              label={st.syncClipboard ? 'Clipboard sync on' : 'Clipboard sync off'}
              active={st.syncClipboard && s.perms.clipboard}
              disabled={!s.perms.clipboard}
              onClick={() => updateSettings({ syncClipboard: !st.syncClipboard })}
            >
              <Clipboard size={18} />
            </IconButton>
            <IconButton label="Send files" disabled={!s.perms.files} onClick={() => fileRef.current?.click()}>
              <Upload size={18} />
            </IconButton>
            <IconButton
              label="Chat"
              active={chatOpen}
              onClick={() => {
                setChatOpen(!chatOpen);
                setSeen(s.chat.filter((m) => m.from === 'them').length);
              }}
            >
              <MessageSquare size={18} />
              {!chatOpen && unread > 0 && <span class="badge">{unread}</span>}
            </IconButton>
            <IconButton label="Screenshot" onClick={screenshot}>
              <Camera size={18} />
            </IconButton>
            <IconButton label={recorder ? 'Stop recording' : 'Record session'} active={!!recorder} onClick={toggleRecording} class={recorder ? 'recording' : ''}>
              {recorder ? <CircleStop size={18} /> : <Circle size={18} />}
            </IconButton>
            <IconButton label={s.viewOnly ? 'Enable control' : 'View only'} active={s.viewOnly} onClick={() => s.setViewOnly(!s.viewOnly)} disabled={!host?.caps.control || !s.perms.control}>
              {s.viewOnly ? <Eye size={18} /> : <MousePointer2 size={18} />}
            </IconButton>
            <IconButton label="Connection details" active={showStats} onClick={() => (setShowStats(!showStats), updateSettings({ showStats: !showStats }))}>
              <Activity size={18} />
            </IconButton>
            <IconButton label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen}>
              {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            </IconButton>
            <IconButton label="Disconnect" class="danger" onClick={() => closeTab(tab.key)} data-testid="disconnect">
              <X size={18} />
            </IconButton>
          </div>
        </div>
      )}

      <div class={`stage ${scale}`} ref={stageRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <video
          ref={videoRef}
          class={`remote ${control ? 'controllable' : ''}`}
          autoPlay
          playsInline
          muted
          disablePictureInPicture
          onResize={onVideoResize}
          onLoadedMetadata={onVideoResize}
          style={vw ? { width: `${vw}px`, height: `${vh}px` } : { visibility: 'hidden' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
          data-testid="remote-video"
        />
        <audio ref={audioRef} autoPlay />
        {connected && !vw && (
          <div class="overlay soft">
            <Spinner size={28} />
            <p>Starting video…</p>
          </div>
        )}
        {s.state === 'reconnecting' && (
          <div class="overlay soft">
            <Spinner size={28} />
            <p>Connection interrupted — reconnecting…</p>
          </div>
        )}
        {!connected && <StatusOverlay tab={tab} password={password} setPassword={setPassword} />}
        {viewOnlyReason && <div class="notice-chip">{viewOnlyReason}</div>}
        {showStats && stats && connected && <StatsPanel stats={stats} code={host?.securityCode} via={host?.via ?? null} />}
      </div>

      {chatOpen && <ChatPanel title={name} messages={[...s.chat]} onSend={(t) => s.sendChat(t)} onClose={() => setChatOpen(false)} />}
      {showTransfers && transfers.length > 0 && <TransferList transfers={transfers} files={s.files} onClose={() => setShowTransfers(false)} />}

      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = e.currentTarget.files;
          if (files?.length) {
            s.sendFiles(files);
            setShowTransfers(true);
          }
          e.currentTarget.value = '';
        }}
      />
      {/* Hidden input that summons the on-screen keyboard on phones and tablets. */}
      <input
        ref={kbdRef}
        class="soft-keyboard"
        aria-label="On-screen keyboard input"
        autoCapitalize="off"
        autoComplete="off"
        spellcheck={false}
        onKeyDown={(e) => e.stopPropagation()}
        onKeyUp={(e) => e.stopPropagation()}
        onBeforeInput={(e: InputEvent) => {
          e.preventDefault();
          if (e.inputType === 'deleteContentBackward') s.combo(['Backspace']);
          else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') s.combo(['Enter']);
          else if (e.data) s.text(e.data);
        }}
      />
    </div>
  );
}

function StatusOverlay({ tab, password, setPassword }: { tab: Tab; password: string; setPassword: (v: string) => void }) {
  const s = tab.session;
  // Subscribe directly: @preact/signals skips re-rendering children whose props did not change.
  useEvents(s, ['state', 'host', 'closed']);
  const name = s.host?.name ?? formatId(tab.hostId);
  const reason = s.closeReason;
  const [message, setMessage] = useState('');
  useEffect(() => s.on('closed', (c) => setMessage(c.message)), [s]);

  if (s.state !== 'closed') {
    const text =
      s.state === 'waiting'
        ? `Waiting for ${name} to accept…`
        : s.state === 'authenticating'
          ? 'Verifying…'
          : s.state === 'starting'
            ? 'Starting secure connection…'
            : `Connecting to ${formatId(tab.hostId)}…`;
    return (
      <div class="overlay">
        <div class="status-card" role="status">
          <Spinner size={32} />
          <h3>{text}</h3>
          {s.state === 'waiting' && (
            <>
              <p class="hint">Ask the other person to click “Accept”.</p>
              {s.host?.securityCode && (
                <p class="security-code inline">
                  <ShieldAlert size={14} /> Security code <code>{s.host.securityCode}</code>
                </p>
              )}
            </>
          )}
          <Button onClick={() => closeTab(tab.key)}>Cancel</Button>
        </div>
      </div>
    );
  }

  const needsPassword = reason === 'bad-password' || reason === 'password-required';
  return (
    <div class="overlay">
      <div class="status-card" role="alert">
        <h3>{reason === 'remote-closed' || reason === 'local' ? 'Session ended' : 'Could not connect'}</h3>
        <p>{message || 'The connection ended.'}</p>
        {reason === 'identity-changed' && (
          <p class="hint">If the other person reinstalled BeamDesk, you can trust the new identity. Otherwise, do not continue.</p>
        )}
        {needsPassword && (
          <form
            class="password-box"
            onSubmit={(e) => {
              e.preventDefault();
              reconnect(tab.key, { password, remember: false });
            }}
          >
            <input type="password" class="input" placeholder="Password" autoFocus value={password} onInput={(e) => setPassword(e.currentTarget.value)} aria-label="Password" />
            <Button type="submit" variant="primary">
              Connect
            </Button>
          </form>
        )}
        <div class="row-actions center">
          {!needsPassword && reason !== 'identity-changed' && (
            <Button variant="primary" onClick={() => reconnect(tab.key)}>
              Reconnect
            </Button>
          )}
          {reason === 'identity-changed' && (
            <Button variant="danger" onClick={() => reconnect(tab.key, { acceptNewKey: true })}>
              Trust new identity and connect
            </Button>
          )}
          <Button onClick={() => closeTab(tab.key)}>Close</Button>
        </div>
      </div>
    </div>
  );
}

function StatsPanel({ stats, code, via }: { stats: ConnectionStats; code?: string; via: string | null }) {
  const rows: [string, string][] = [
    ['Route', `${stats.route === 'relay' ? 'Relayed (TURN)' : stats.route === 'direct' ? 'Direct peer-to-peer' : '—'}${stats.protocol ? ` · ${stats.protocol}` : ''}`],
    ['Latency', stats.rttMs !== null ? `${stats.rttMs} ms` : '—'],
    ['Frame rate', `${stats.fps} fps`],
    ['Resolution', stats.width ? `${stats.width}×${stats.height}` : '—'],
    ['Bitrate', formatBitrate(stats.bitrate)],
    ['Codec', stats.codec || '—'],
    ['Packet loss', `${(stats.packetLoss * 100).toFixed(1)}%`],
    ['Buffer', stats.bufferMs !== null ? `${stats.bufferMs} ms` : '—'],
    ['Decode', stats.decodeMs !== null ? `${stats.decodeMs} ms` : '—'],
    ['Encryption', 'DTLS-SRTP, end to end'],
    ['Verified by', via === 'otp' ? 'One-time password' : via === 'perm' ? 'Permanent password' : via === 'approval' ? 'Approval on the device' : '—'],
  ];
  if (code) rows.push(['Security code', code]);
  return (
    <div class="stats-panel" aria-label="Connection details">
      {rows.map(([k, v]) => (
        <div class="stats-row" key={k}>
          <span>{k}</span>
          <strong>{v}</strong>
        </div>
      ))}
    </div>
  );
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
