# Changelog

## 1.1.0 — host mode

**Make one of your computers the BeamDesk server**, with no outside service: Settings → Network → *This computer is the server*.

- The desktop app runs the signaling server over HTTPS/WSS (TLS 1.3 only) with its own self-signed certificate, plus a built-in STUN/TURN relay — all on one port (41443, TCP and UDP).
- **Connection codes** (`BD1-…`) for your other computers carry the server's addresses (home network, Tailscale, internet, an optional dynamic DNS name), its certificate fingerprint and a 128-bit access key. Apps accept that exact certificate only (pinned, checked before any message), and try every address at once.
- Opens the port on the router automatically (UPnP IGD, then NAT-PMP), renews the lease and closes it again when host mode stops. Detects carrier-grade NAT and Tailscale, and checks whether the server is reachable.
- Easy to switch on and off: a switch in Settings and in the tray menu; after a restart BeamDesk starts at sign-in and turns host mode back on with the same code; keeps the computer awake while hosting (optional).
- The relay only connects devices of this server with each other — it cannot be used to reach the home network, other programs on the computer, or the internet. Quotas per device and in total, rate-limited answers to strangers, per-address connection limits, no owner name or device count in public responses.
- A link for phones and browsers (access key in the `#fragment`), *Make a new code* to lock out every old code, an *Internet name* for dynamic DNS.
- Settings → Network redesigned: server address, connection code or host mode, with step-by-step guides for Tailscale, a free Render server and manual port forwarding.
- Fixed: the server information line in Settings → Network always said "Could not reach the server" in the desktop app (missing CORS header on `/api/info`).
- The Windows "Publisher" is now Neurosmith.

## 1.0.1

- The "Save this file?" dialog names the sender by its verified device name and ID instead of only a number.
- Updated to preact 11, TypeScript 7, Vite 8, esbuild 0.28, Playwright 1.64 and noble-curves/hashes 2.4.
- Releases can be published from the Actions tab (**Release desktop apps → Run workflow** with a version); pull requests that touch the server image now build it before merging.
- New screenshots in light and dark theme (they follow your GitHub theme in the README and user guide), generated from the real app with `npm run screenshots`.

## 1.0.0 — first release

Security audit before release — 32 issues fixed, see [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md). Highlights:

- Fixed a pre-authentication crash of the server (deeply nested JSON) and added protection against slow requests, floods and resource exhaustion.
- Protocol v2: the host signs its password offer (no downgrade), viewers require password proof on first contact, sessions cannot be ended or stalled by the server, viewers reveal their IP only to a verified host.
- Files need the receiver's consent before any data is sent; risky types are flagged, shortcut files refused, received files marked as downloaded from the internet.
- Help-link invites carry a token (no fake "support" invites); one-time passwords are spent on use and hidden during sessions; per-device password lockout.
- Desktop: Electron fuses, CSP for the app UI, exact origin checks, input only during sessions that allow control, minimal macOS entitlements.
- Release builds run without write access; checksums are published with each release; Dependabot enabled. TURN relay restricted to UDP to public addresses.

- Desktop app for Windows, macOS and Linux (Electron) and a browser version served by the server.
- 9-digit IDs derived from per-device Ed25519 keys; signed server registration.
- Accept prompt with per-session permissions, one-time passwords (each works once), unattended access with a permanent password, trusted devices, block list.
- CPace password authentication and identity signatures bound to the DTLS fingerprints; host IP hidden until acceptance (inlined SDP candidates included); key pinning on the viewer.
- Signed acceptances, DTLS certificate pinning across ICE restarts, key-bound invite/help links with a confirmation step, per-IP limits on new device registrations, bounded pending requests.
- Remote control: mouse, scroll, keyboard (layout-independent text mode and physical mode), special key combinations, Cmd ↔ Ctrl translation, touch gestures and on-screen keyboard on phones.
- Multi-monitor switching, quality presets and custom limits, hardware-aware codec selection, live connection stats, automatic ICE restarts.
- Clipboard sync, file transfer with progress and delivery receipts, chat, remote sound (Windows hosts), screenshots and recording.
- Help links (reverse connections) for people without BeamDesk, invite links, deep links, address book with presence.
- Tray, start at login, always-on-top session bar, lock screen after sessions, admin config file.
- Self-hosting: Docker image, Docker Compose with Caddy HTTPS and coturn, Render and Fly.io configs.
- Unit, integration and Playwright end-to-end tests (browser↔browser and desktop host); CI, release and image workflows.
