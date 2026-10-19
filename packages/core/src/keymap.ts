/**
 * Keyboard handling.
 *
 * The viewer sends physical key codes (KeyboardEvent.code) for shortcuts and special keys,
 * and - in the default "translate" mode - printable characters as text. Typing text makes
 * input layout independent: a German viewer typing "ü" on a US-layout host gets "ü".
 * The host maps codes to native key names understood by its input driver.
 */
import type { Platform } from './protocol.ts';

const NAMED: Record<string, string> = {
  Enter: 'enter',
  NumpadEnter: 'enter',
  Escape: 'escape',
  Backspace: 'backspace',
  Tab: 'tab',
  Space: 'space',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  CapsLock: 'capslock',
  ShiftLeft: 'shift',
  ShiftRight: 'right_shift',
  ControlLeft: 'control',
  ControlRight: 'right_control',
  AltLeft: 'alt',
  AltRight: 'right_alt',
  MetaLeft: 'command',
  MetaRight: 'command',
  OSLeft: 'command',
  OSRight: 'command',
  ContextMenu: 'menu',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Insert: 'insert',
  Delete: 'delete',
  PrintScreen: 'printscreen',
  NumLock: 'numpad_lock',
  NumpadAdd: 'numpad_+',
  NumpadSubtract: 'numpad_-',
  NumpadMultiply: 'numpad_*',
  NumpadDivide: 'numpad_/',
  NumpadDecimal: 'numpad_.',
  AudioVolumeMute: 'audio_mute',
  AudioVolumeDown: 'audio_vol_down',
  AudioVolumeUp: 'audio_vol_up',
  MediaPlayPause: 'audio_play',
  MediaStop: 'audio_stop',
  MediaTrackPrevious: 'audio_prev',
  MediaTrackNext: 'audio_next',
};

/** Maps KeyboardEvent.code to the host input driver's key name, or null if unsupported. */
export function codeToKey(code: string): string | null {
  if (NAMED[code]) return NAMED[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `numpad_${m[1]}`;
  m = /^F(\d{1,2})$/.exec(code);
  if (m && +m[1] >= 1 && +m[1] <= 24) return `f${m[1]}`;
  return null;
}

/** Every key name the host is allowed to press (used to validate IPC on the desktop). */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  ...Object.values(NAMED),
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  ...Array.from({ length: 10 }, (_, i) => `numpad_${i}`),
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
]);

export const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
]);

export type KeyboardMode = 'translate' | 'physical';

export interface KeyAction {
  /** Physical key transitions to send, in order. */
  keys: { code: string; down: boolean }[];
  /** Text to type (translate mode). */
  text?: string;
  /** Whether the browser default action must be suppressed. */
  preventDefault: boolean;
}

/**
 * Swaps Cmd and Ctrl when a Mac controls Windows/Linux (and vice versa),
 * so muscle memory shortcuts like Cmd+C keep working.
 */
export function translateModifierCode(code: string, viewer: Platform, host: Platform, enabled: boolean): string {
  if (!enabled) return code;
  const viewerMac = viewer === 'macos' || viewer === 'ios';
  const hostMac = host === 'macos';
  if (viewerMac && !hostMac) {
    if (code === 'MetaLeft' || code === 'OSLeft') return 'ControlLeft';
    if (code === 'MetaRight' || code === 'OSRight') return 'ControlRight';
  }
  if (!viewerMac && hostMac) {
    if (code === 'ControlLeft') return 'MetaLeft';
    if (code === 'ControlRight') return 'MetaRight';
  }
  return code;
}

export interface KeyLike {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  getModifierState?(k: string): boolean;
}

/**
 * Decides what to send for a keydown/keyup in the viewer. Pure function, easy to unit test.
 * `held` is the set of codes currently held down (mutated).
 */
export function planKeyEvent(e: KeyLike, down: boolean, mode: KeyboardMode, held: Set<string>): KeyAction {
  const code = e.code;
  if (!code || e.isComposing) return { keys: [], preventDefault: false };

  if (mode === 'physical') {
    if (!codeToKey(code)) return { keys: [], preventDefault: true };
    if (down) held.add(code);
    else if (!held.delete(code)) return { keys: [], preventDefault: true };
    return { keys: [{ code, down }], preventDefault: true };
  }

  // Translate mode. Dead keys (accents) resolve into a printable key on the next keydown.
  if (e.key === 'Dead') return { keys: [], preventDefault: true };
  const altGraph = !!e.getModifierState?.('AltGraph');
  const printable = [...e.key].length === 1;
  const shortcut = (e.ctrlKey || e.metaKey || e.altKey) && !altGraph;

  if (MODIFIER_CODES.has(code)) {
    // AltGr on Windows arrives as a synthetic ControlLeft + AltRight; never forward it.
    if (code === 'AltRight' && (altGraph || e.key === 'AltGraph')) return { keys: [], preventDefault: true };
    if (down) held.add(code);
    else if (!held.delete(code)) return { keys: [], preventDefault: true };
    return { keys: [{ code, down }], preventDefault: true };
  }

  if (printable && !shortcut) {
    // Text goes as a single "type" action on keydown; keyup is a no-op.
    return down ? { keys: [], text: e.key, preventDefault: true } : { keys: [], preventDefault: true };
  }

  if (!codeToKey(code)) return { keys: [], preventDefault: shortcut };
  if (down) held.add(code);
  else if (!held.delete(code)) return { keys: [], preventDefault: true };
  return { keys: [{ code, down }], preventDefault: true };
}

/** Ready-made special key combinations offered in the viewer toolbar. */
export const SPECIAL_COMBOS: { label: string; keys: string[]; hosts?: Platform[] }[] = [
  { label: 'Ctrl + Alt + Del', keys: ['ControlLeft', 'AltLeft', 'Delete'], hosts: ['linux'] },
  { label: 'Windows / Super key', keys: ['MetaLeft'], hosts: ['windows', 'linux'] },
  { label: 'Alt + Tab', keys: ['AltLeft', 'Tab'], hosts: ['windows', 'linux'] },
  { label: 'Alt + F4', keys: ['AltLeft', 'F4'], hosts: ['windows', 'linux'] },
  { label: 'Win + D (show desktop)', keys: ['MetaLeft', 'KeyD'], hosts: ['windows'] },
  { label: 'Win + L (lock)', keys: ['MetaLeft', 'KeyL'], hosts: ['windows'] },
  { label: 'Ctrl + Shift + Esc (Task Manager)', keys: ['ControlLeft', 'ShiftLeft', 'Escape'], hosts: ['windows'] },
  { label: 'Cmd + Tab', keys: ['MetaLeft', 'Tab'], hosts: ['macos'] },
  { label: 'Cmd + Space (Spotlight)', keys: ['MetaLeft', 'Space'], hosts: ['macos'] },
  { label: 'Cmd + Q', keys: ['MetaLeft', 'KeyQ'], hosts: ['macos'] },
  { label: 'Ctrl + Cmd + Q (lock)', keys: ['ControlLeft', 'MetaLeft', 'KeyQ'], hosts: ['macos'] },
  { label: 'Print Screen', keys: ['PrintScreen'], hosts: ['windows', 'linux'] },
  { label: 'Escape', keys: ['Escape'] },
];
