/**
 * Native input injection (mouse and keyboard) with @jitsi/robotjs.
 * Every command comes from the renderer, which only forwards input from authenticated
 * sessions that have the "control" permission. We still validate everything here.
 */
import { screen } from 'electron';
import { createRequire } from 'node:module';
import { ALLOWED_KEYS } from '@beamdesk/core/keymap';
import type { InputCommand } from '@beamdesk/core/host';

type Robot = typeof import('@jitsi/robotjs');

const require = createRequire(__filename);
let robot: Robot | null = null;
let loadError = '';
try {
  robot = require('@jitsi/robotjs') as Robot;
  robot.setMouseDelay(0);
  robot.setKeyboardDelay(0);
} catch (err) {
  loadError = (err as Error).message;
  console.warn('[input] remote control unavailable:', loadError);
}

const wayland = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

export const isWayland = wayland;

/** Remote control works when the native driver loaded and the session is not pure Wayland. */
export function inputAvailable(): boolean {
  return !!robot && !wayland;
}

const MODIFIERS = ['shift', 'right_shift', 'control', 'right_control', 'alt', 'right_alt', 'command'];
const heldKeys = new Set<string>();
const heldButtons = new Set<'left' | 'middle' | 'right'>();
let wheelX = 0;
let wheelY = 0;

const clamp01 = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

function toScreen(displayId: string, x: number, y: number): { x: number; y: number } {
  const displays = screen.getAllDisplays();
  const d = displays.find((s) => String(s.id) === displayId) ?? screen.getPrimaryDisplay();
  const b = d.bounds;
  const point = {
    x: b.x + Math.min(b.width - 1, clamp01(x) * b.width),
    y: b.y + Math.min(b.height - 1, clamp01(y) * b.height),
  };
  if (process.platform === 'darwin') return { x: Math.round(point.x), y: Math.round(point.y) };
  // Windows/Linux: convert device independent pixels to physical screen pixels.
  const p = screen.dipToScreenPoint(point);
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function scroll(dx: number, dy: number): void {
  if (!robot) return;
  if (process.platform === 'win32') {
    // WHEEL_DELTA (120) per ~100px of browser scroll.
    robot.scrollMouse(Math.round(-dx * 1.2), Math.round(-dy * 1.2));
  } else if (process.platform === 'darwin') {
    robot.scrollMouse(Math.round(-dx), Math.round(-dy));
  } else {
    // X11 only knows wheel "clicks": accumulate pixels into notches.
    wheelX += -dx;
    wheelY += -dy;
    const nx = Math.trunc(wheelX / 100);
    const ny = Math.trunc(wheelY / 100);
    wheelX -= nx * 100;
    wheelY -= ny * 100;
    if (nx || ny) robot.scrollMouse(nx, ny);
  }
}

function key(name: string, down: boolean): void {
  if (!robot || !ALLOWED_KEYS.has(name)) return;
  robot.keyToggle(name, down ? 'down' : 'up');
  if (down) heldKeys.add(name);
  else heldKeys.delete(name);
}

export function releaseAll(): void {
  if (!robot) return;
  for (const k of [...heldKeys]) {
    try {
      robot.keyToggle(k, 'up');
    } catch {
      /* ignore */
    }
  }
  heldKeys.clear();
  for (const b of [...heldButtons]) {
    try {
      robot.mouseToggle('up', b);
    } catch {
      /* ignore */
    }
  }
  heldButtons.clear();
}

export function handleInput(displayId: unknown, cmd: InputCommand): void {
  if (!inputAvailable() || !cmd || typeof cmd !== 'object') return;
  const r = robot!;
  const id = typeof displayId === 'string' ? displayId : '';
  try {
    switch (cmd.k) {
      case 'move': {
        const p = toScreen(id, cmd.x, cmd.y);
        r.moveMouse(p.x, p.y);
        break;
      }
      case 'button': {
        if (!['left', 'middle', 'right'].includes(cmd.button)) return;
        const p = toScreen(id, cmd.x, cmd.y);
        r.moveMouse(p.x, p.y);
        r.mouseToggle(cmd.down ? 'down' : 'up', cmd.button);
        if (cmd.down) heldButtons.add(cmd.button);
        else heldButtons.delete(cmd.button);
        break;
      }
      case 'wheel': {
        const p = toScreen(id, cmd.x, cmd.y);
        r.moveMouse(p.x, p.y);
        scroll(Number(cmd.dx) || 0, Number(cmd.dy) || 0);
        break;
      }
      case 'key':
        if (typeof cmd.key === 'string') key(cmd.key, !!cmd.down);
        break;
      case 'text': {
        if (typeof cmd.text !== 'string' || !cmd.text || cmd.text.length > 4096) return;
        // Type with no modifiers held, so "A" is never turned into Shift+Shift+A etc.
        const active = MODIFIERS.filter((m) => heldKeys.has(m));
        for (const m of active) r.keyToggle(m, 'up');
        r.typeString(cmd.text);
        for (const m of active) r.keyToggle(m, 'down');
        break;
      }
      case 'combo': {
        const keys = Array.isArray(cmd.keys) ? cmd.keys.filter((k) => typeof k === 'string' && ALLOWED_KEYS.has(k)).slice(0, 6) : [];
        for (const k of keys) r.keyToggle(k, 'down');
        for (const k of [...keys].reverse()) r.keyToggle(k, 'up');
        break;
      }
      case 'release':
        releaseAll();
        break;
    }
  } catch (err) {
    console.warn('[input] command failed', cmd.k, (err as Error).message);
  }
}
