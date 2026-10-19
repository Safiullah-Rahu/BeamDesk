# Changelog

## 1.0.0 — first release

- Desktop app for Windows, macOS and Linux (Electron) and a browser version served by the server.
- 9-digit IDs derived from per-device Ed25519 keys; signed server registration.
- Accept prompt with per-session permissions, one-time passwords (rotate after each session), unattended access with a permanent password, trusted devices, block list.
- CPace password authentication and identity signatures bound to the DTLS fingerprints; host IP hidden until acceptance; key pinning on the viewer.
- Remote control: mouse, scroll, keyboard (layout-independent text mode and physical mode), special key combinations, Cmd ↔ Ctrl translation, touch gestures and on-screen keyboard on phones.
- Multi-monitor switching, quality presets and custom limits, hardware-aware codec selection, live connection stats, automatic ICE restarts.
- Clipboard sync, file transfer with progress and delivery receipts, chat, remote sound (Windows hosts), screenshots and recording.
- Help links (reverse connections) for people without BeamDesk, invite links, deep links, address book with presence.
- Tray, start at login, always-on-top session bar, lock screen after sessions, admin config file.
- Self-hosting: Docker image, Docker Compose with Caddy HTTPS and coturn, Render and Fly.io configs.
- Unit, integration and Playwright end-to-end tests (browser↔browser and desktop host); CI, release and image workflows.
