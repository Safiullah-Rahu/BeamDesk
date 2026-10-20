# Development

## Prerequisites

- Node.js 22 (or ≥ 20.18; the tests use Node's built-in TypeScript support, available from 22.6)
- For desktop packaging: nothing extra — the native input driver ships prebuilt N-API binaries.
- Linux desktop testing: an X11 session (or `xvfb-run`), `libxtst6`.

## Setup

```bash
npm install          # installs all workspaces (and downloads Electron)
```

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Build the UI, start the server with auto-reload on `http://localhost:8080` |
| `npm run dev:web` | Vite dev server for the UI on `:5173` (proxies `/ws` and `/api` to `:8080`) |
| `npm run dev:desktop` | Build and start the desktop app. Set `BEAMDESK_SERVER_URL=http://localhost:8080` or pick the server in Settings |
| `npm run build` | Production builds of UI, server and desktop bundles |
| `npm run typecheck` | `tsc` over all workspaces |
| `npm test` | Unit and integration tests (Node test runner): crypto, protocol, file transfer, server |
| `npm run test:e2e` | Playwright: two isolated browsers connecting through a real server |
| `npm run dist:desktop` | Installers for the current OS in `apps/desktop/release` |

Desktop host end-to-end test (Linux):

```bash
npm run build -w apps/desktop
BEAMDESK_E2E_DESKTOP=1 xvfb-run -a -s "-screen 0 1280x800x24" npx playwright test -c e2e/playwright.config.ts desktop.spec.ts
```

It launches the Electron app as host on a virtual display, connects a browser viewer with the one-time password, moves the remote mouse (and checks the real cursor position), syncs the clipboard, transfers a file and verifies password rotation.

`hostmode.spec.ts` (same command, same variable) covers host mode with two desktop apps and a browser: the code is rejected with a forged certificate fingerprint and accepted with the real one, a session forced through the relay uses the built-in TURN server, the browser link connects, and host mode comes back on by itself after the app restarts.

## Code map

- `packages/core/src/viewer.ts` — the viewer state machine.
- `packages/core/src/host.ts` — incoming request handling, decisions, capture, input forwarding.
- `packages/core/src/cpace.ts`, `identity.ts` — cryptography (with tests in `packages/core/test`).
- `server/src/server.ts` — signaling server.
- `server/src/hostmode.ts` — host mode (with `turn.ts`, `portmap.ts`, `netinfo.ts`, `cert.ts`); `apps/desktop/src/hostserver.ts` runs it in the app, `pinnedsocket.ts` connects to home servers.
- `apps/web/src/state/app.ts` — application state, links, address book, trust store.
- `apps/web/src/ui/Viewer.tsx` — remote screen, input capture, toolbar.
- `apps/desktop/src/main.ts` — Electron main process; `input.ts` input injection; `preload.ts` the bridge.

Core TypeScript is consumed as source (no build step): Vite and esbuild bundle it; Node runs tests with type stripping. Keep to erasable TypeScript syntax (no `enum`, no parameter properties).

## Debugging tips

- Connection details (📈 in a session) show the route (direct/relay), RTT, codec and frame stats.
- `chrome://webrtc-internals` (browser) or `--remote-debugging-port=9222` (desktop: `npx electron apps/desktop --remote-debugging-port=9222`) give full WebRTC traces.
- `/api/info` on the server reports whether TURN is configured.

## Screenshots

The images in `docs/images` (light and dark theme) are generated from the real desktop app and browser version. After UI changes, regenerate them on Linux:

```bash
npm run build
dbus-run-session -- sh -c 'echo | gnome-keyring-daemon --unlock --components=secrets >/dev/null &&
  xvfb-run -a -s "-screen 0 1280x820x24" npm run screenshots'
```

`gnome-keyring` and `xvfb` must be installed; the keyring lets the desktop app store its secrets as on a normal Linux desktop.

The host mode images need a home network with a router, so they are made in a private network namespace with a fake UPnP router: `e2e/netns-screenshots.sh` (also needs `unshare` and `iproute2`).

## Releasing

1. Bump the version everywhere: `npm version X.Y.Z --no-git-tag-version --workspaces --include-workspace-root`, and `APP_VERSION` in `packages/core/src/protocol.ts`.
2. Update `CHANGELOG.md`.
3. Actions tab → **Release desktop apps** → **Run workflow** on `main` with the version `vX.Y.Z` (or push the tag yourself: `git tag vX.Y.Z && git push origin vX.Y.Z`). GitHub Actions builds the Windows, macOS and Linux installers, creates the tag and the release with a `SHA256SUMS.txt`, and publishes the server image to GHCR.
