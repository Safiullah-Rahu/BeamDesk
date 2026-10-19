import { useEffect } from 'preact/hooks';
import { House, Moon, Settings as SettingsIcon, Sun, X } from 'lucide-preact';
import { activeTab, closeTab, hosted, needsServer, settings, settingsOpen, tabs, updateSettings } from '../state/app.ts';
import { DeviceCard } from './DeviceCard.tsx';
import { ConnectCard, ContactsCard } from './ConnectCard.tsx';
import { HostedSessions } from './HostedSessions.tsx';
import { IncomingPrompts } from './IncomingPrompt.tsx';
import { Viewer } from './Viewer.tsx';
import { SettingsModal } from './Settings.tsx';
import { FileConsent, HelpLanding, InviteBanners, LinkConfirm, NeedsServer, SetupNotices, Toasts } from './Overlays.tsx';
import { IconButton } from './kit.tsx';
import { useEvents } from './hooks.ts';
import type { Tab } from '../state/app.ts';
import { Logo } from './Logo.tsx';

function TabButton({ tab }: { tab: Tab }) {
  useEvents(tab.session, ['state']);
  const st = tab.session.state;
  const dot = st === 'connected' ? 'ok' : st === 'closed' ? 'err' : 'busy';
  return (
    <div class={`tab ${activeTab.value === tab.key ? 'on' : ''}`} role="presentation">
      <button role="tab" aria-selected={activeTab.value === tab.key} class="tab-btn" onClick={() => (activeTab.value = tab.key)} title={tab.title}>
        <span class={`state-dot ${dot}`} aria-hidden="true" />
        <span class="tab-title">{tab.title}</span>
      </button>
      <button class="tab-close" aria-label={`Close ${tab.title}`} onClick={() => closeTab(tab.key)}>
        <X size={14} />
      </button>
    </div>
  );
}

function useTheme() {
  const theme = settings.value.theme;
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);
}

export function App() {
  useTheme();
  const dark = settings.value.theme === 'dark' || (settings.value.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const home = activeTab.value === 'home';
  return (
    <div class="app">
      <header class="topbar">
        <div class="brand" onClick={() => (activeTab.value = 'home')}>
          <Logo size={28} />
          <span>BeamDesk</span>
        </div>
        <nav class="tabs" role="tablist" aria-label="Sessions">
          <div class={`tab ${home ? 'on' : ''}`} role="presentation">
            <button role="tab" aria-selected={home} class="tab-btn" onClick={() => (activeTab.value = 'home')}>
              <House size={16} />
              <span class="tab-title">Home</span>
              {hosted.value.length > 0 && <span class="live-dot small" title="Someone is connected to this device" />}
            </button>
          </div>
          {tabs.value.map((t) => (
            <TabButton key={t.key} tab={t} />
          ))}
        </nav>
        <div class="topbar-actions">
          <IconButton label={dark ? 'Light theme' : 'Dark theme'} onClick={() => updateSettings({ theme: dark ? 'light' : 'dark' })}>
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </IconButton>
          <IconButton label="Settings" onClick={() => (settingsOpen.value = true)} data-testid="open-settings">
            <SettingsIcon size={18} />
          </IconButton>
        </div>
      </header>

      <InviteBanners />

      <main class={`home ${home ? '' : 'hidden'}`} aria-hidden={!home}>
        {needsServer.value && <NeedsServer />}
        <SetupNotices />
        <HostedSessions />
        <div class="home-grid">
          <DeviceCard />
          <ConnectCard />
        </div>
        <ContactsCard />
        <footer class="foot">
          <span>End-to-end encrypted · Open source</span>
        </footer>
      </main>

      {tabs.value.map((t) => (
        <Viewer key={t.key} tab={t} active={activeTab.value === t.key} />
      ))}

      <IncomingPrompts />
      <HelpLanding />
      <LinkConfirm />
      <FileConsent />
      <SettingsModal />
      <Toasts />
    </div>
  );
}

