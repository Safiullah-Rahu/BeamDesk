import { render } from 'preact';
import './styles.css';

const root = document.getElementById('app')!;

// The desktop app reuses this bundle for its small "session bar" window.
if (location.hash === '#session-bar') {
  document.documentElement.classList.add('bar-window');
  const { SessionBar } = await import('./ui/SessionBar.tsx');
  render(<SessionBar />, root);
} else {
  const [{ App }, { boot }] = await Promise.all([import('./ui/App.tsx'), import('./state/app.ts')]);
  render(<App />, root);
  await boot();
}
