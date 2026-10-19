/** Operating system integration: screen lock, start at login, macOS privacy permissions. */
import { app, shell, systemPreferences } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWayland } from './input.ts';

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: false });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

export async function lockScreen(): Promise<void> {
  if (process.platform === 'win32') {
    await run('rundll32.exe', ['user32.dll,LockWorkStation']);
  } else if (process.platform === 'darwin') {
    // Locks when "require password after sleep" is on (the macOS default).
    await run('pmset', ['displaysleepnow']);
  } else if (!(await run('loginctl', ['lock-session']))) {
    if (!(await run('xdg-screensaver', ['lock']))) await run('gnome-screensaver-command', ['-l']);
  }
}

const AUTOSTART_FILE = path.join(os.homedir(), '.config', 'autostart', 'beamdesk.desktop');

export function setLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return;
  if (process.platform === 'linux') {
    try {
      if (!enabled) {
        fs.rmSync(AUTOSTART_FILE, { force: true });
        return;
      }
      const exec = process.env.APPIMAGE || process.execPath;
      fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
      fs.writeFileSync(
        AUTOSTART_FILE,
        `[Desktop Entry]\nType=Application\nName=BeamDesk\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\nTerminal=false\n`,
      );
    } catch (err) {
      console.warn('[system] autostart failed', err);
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}

export function startedHidden(): boolean {
  // macOS login items cannot pass arguments; it reports whether we were opened at login instead.
  return process.argv.includes('--hidden') || (process.platform === 'darwin' && !!app.getLoginItemSettings().wasOpenedAtLogin);
}

export function permissions() {
  if (process.platform !== 'darwin') {
    return { screen: 'granted' as const, accessibility: true, wayland: isWayland };
  }
  const status = systemPreferences.getMediaAccessStatus('screen');
  return {
    screen: (['granted', 'denied', 'not-determined', 'restricted'].includes(status) ? status : 'unknown') as 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown',
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    wayland: false,
  };
}

export function openPermissionSettings(kind: 'screen' | 'accessibility'): void {
  if (process.platform !== 'darwin') return;
  if (kind === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true);
  const pane = kind === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility';
  void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
}

/**
 * Optional admin config ("beamdesk.json" next to the executable or in the user data folder)
 * so IT can pre-configure the server for everyone: { "serverUrl": "...", "accessKey": "..." }.
 */
export function adminConfig(): { serverUrl?: string; accessKey?: string } {
  const candidates = [path.join(path.dirname(process.execPath), 'beamdesk.json'), path.join(app.getPath('userData'), 'beamdesk.json')];
  for (const file of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && typeof j === 'object') return { serverUrl: typeof j.serverUrl === 'string' ? j.serverUrl : undefined, accessKey: typeof j.accessKey === 'string' ? j.accessKey : undefined };
    } catch {
      /* not present */
    }
  }
  return {};
}
