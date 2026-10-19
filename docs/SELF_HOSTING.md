# Self-hosting BeamDesk

BeamDesk needs one small server. It:

- registers devices and checks that each device really owns its ID,
- passes connection requests between two online devices,
- hands out TURN relay credentials (when you run a relay),
- serves the browser version of BeamDesk.

Screen video, input, chat, clipboard and files **never pass through it** — they flow directly between devices, end-to-end encrypted.
When two networks are too strict for a direct connection (some corporate or mobile networks), traffic goes through a **TURN relay**, which only ever sees encrypted packets.

**Requirements:** any Linux machine with a public IP (1 vCPU / 512 MB RAM is plenty for thousands of devices), a domain name, and Docker. HTTPS is mandatory because browsers only allow screen sharing and encryption APIs on secure pages.

- [Option A — Docker Compose with HTTPS and TURN (recommended)](#option-a--docker-compose-with-https-and-turn-recommended)
- [Option B — Render (one click)](#option-b--render)
- [Option C — Fly.io](#option-c--flyio)
- [Option D — plain Node.js](#option-d--plain-nodejs)
- [Try it on your phone](#try-it-on-your-phone)
- [Configuration reference](#configuration-reference)
- [Point the apps at your server](#point-the-apps-at-your-server)
- [Private servers](#private-servers)
- [Operations](#operations)

---

## Option A — Docker Compose with HTTPS and TURN (recommended)

1. Create a DNS **A** record (e.g. `desk.example.com`) pointing at your server.
2. Open these ports in your firewall / cloud security group:

   | Port | Protocol | Used by |
   |---|---|---|
   | 80, 443 | TCP | HTTPS (certificate via Let's Encrypt) |
   | 443 | UDP | HTTP/3 (optional) |
   | 3478 | TCP + UDP | TURN |
   | 49160–49200 | UDP | TURN relay ports |

3. Deploy:

   ```bash
   git clone https://github.com/Safiullah-Rahu/BeamDesk.git
   cd BeamDesk/deploy
   cp .env.example .env
   # edit .env: DOMAIN=desk.example.com and TURN_SECRET=$(openssl rand -hex 32)
   docker compose up -d
   ```

4. Open `https://desk.example.com`. You should see BeamDesk with a green **Ready** pill.
   `https://desk.example.com/api/info` should report `"turn": true`.

The compose file runs three containers:

- **beamdesk** — the server (pre-built image `ghcr.io/safiullah-rahu/beamdesk-server`, or built from source with `docker compose build`),
- **caddy** — HTTPS with automatic certificates,
- **coturn** — the TURN relay, with short-lived credentials derived from `TURN_SECRET`. It only relays UDP to public addresses (no TCP relays; loopback, private, link-local, IPv4-mapped and NAT64 ranges blocked) so it cannot be abused to reach your internal network, caps each session's bandwidth, and keeps the secret in a private config file rather than on the command line.

The server refuses to start if `TURN_SECRET` is missing, shorter than 16 characters or still the example placeholder.

Update: `docker compose pull && docker compose up -d`.

> The pre-built image is published to GitHub Container Registry by the *Server image* workflow. If it cannot be pulled
> (for example while the package is still private — make it public under GitHub → Packages → `beamdesk-server` →
> Package settings), Compose builds it from source instead. You can force that with `docker compose up -d --build`.

---

## Option B — Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Safiullah-Rahu/BeamDesk)

The included [`render.yaml`](../render.yaml) creates a Docker web service with a health check on the **free plan** — perfect for trying BeamDesk. Render provides HTTPS automatically; your server will be at `https://<name>.onrender.com`. For real use switch to a paid instance and uncomment the disk in `render.yaml`, so the device registry (which protects IDs from being taken over) survives restarts.

- Render does not offer UDP, so you cannot run TURN there. Most connections work directly; for strict networks add an external TURN service (see [TURN providers](#turn-without-running-coturn)).
- The free plan sleeps when idle, which drops devices that are waiting for connections. Use a paid instance for always-on hosts.

---

## Option C — Fly.io

```bash
fly launch --copy-config --config deploy/fly.toml --no-deploy   # pick an app name
fly volumes create beamdesk_data --size 1 --config deploy/fly.toml
fly deploy --config deploy/fly.toml
```

Your server will be at `https://<app>.fly.dev`. As with Render, add an external TURN service for strict networks.

---

## Option D — plain Node.js

Node.js 20 or newer:

```bash
git clone https://github.com/Safiullah-Rahu/BeamDesk.git && cd BeamDesk
npm ci
npm run build:web && npm run build -w server
PORT=8080 DATA_DIR=/var/lib/beamdesk node server/dist/server.mjs
```

`server/dist/server.mjs` is a single self-contained file (no `node_modules` needed at runtime); it serves the web app from `apps/web/dist` (or set `WEB_ROOT`). Put it behind a reverse proxy that terminates HTTPS and forwards WebSockets on `/ws` (nginx, Caddy, Traefik), and set `TRUST_PROXY=true`.

Example nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 1h;
}
```

---

## Try it on your phone

Two ways to test BeamDesk between your computer and your phone in a few minutes.

**A. Free test server (works anywhere, with HTTPS).**

1. Click **Deploy to Render** above, sign in, keep the free plan and click **Deploy**. The first build takes about 5 minutes.
2. On your computer, open `https://<name>.onrender.com` in Chrome or Edge and click **Let someone view this screen** (pick the screen to share). Note the **ID** and the **one-time password**.
3. On your phone, open the same address, type the ID, tap **I have a password**, enter the password and tap **Connect** — or leave the password out and click **Accept** on the computer.

For full remote control, install the desktop app on the computer and set the same address in **Settings → Network**.

**B. Same Wi‑Fi, nothing to deploy.** On the computer (Node.js 20+):

```bash
git clone https://github.com/Safiullah-Rahu/BeamDesk.git && cd BeamDesk
npm ci && npm run build:web && npm run build -w server
node server/dist/server.mjs        # prints: on your network: http://192.168.x.y:8080
```

1. On the computer open `http://localhost:8080` (allow Node.js through the firewall if asked) and click **Let someone view this screen**.
2. On the phone (same Wi‑Fi) open the `http://192.168.x.y:8080` address the server printed, and connect with the ID as above.

Plain `http://` pages are fine for watching and controlling from a phone, but browsers disable some features there (clipboard sync, notifications, and screen sharing *from* that page). Use option A or your own HTTPS server for everything else.

---

## Configuration reference

All settings are environment variables.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Interface to listen on |
| `SERVER_NAME` | `BeamDesk` | Shown in the apps (Settings → Network) |
| `DATA_DIR` | `./data` | Where the device registry (`devices.json`) is stored |
| `WEB_ROOT` | auto | Folder with the built web app; empty string disables it |
| `ACCESS_KEY` | — | If set, apps must enter this key to use the server ([private servers](#private-servers)) |
| `TRUST_PROXY` | `false` | Behind a reverse proxy: `true` (one proxy) or the number of proxies in front of the server. The client IP is taken that many entries from the right of `X-Forwarded-For`. Only enable it if nothing but your proxy can reach the server |
| `STUN_URLS` | Google + Cloudflare STUN | Comma-separated STUN URLs |
| `TURN_URLS` | — | Comma-separated TURN URLs, e.g. `turn:desk.example.com:3478?transport=udp,turn:desk.example.com:3478?transport=tcp` |
| `TURN_SECRET` | — | coturn `static-auth-secret`: the server issues time-limited credentials (recommended). At least 16 random characters |
| `TURN_USERNAME` / `TURN_PASSWORD` | — | Static TURN credentials instead of `TURN_SECRET` |
| `TURN_TTL` | `3600` | Lifetime of issued TURN credentials, in seconds (max. 86400); apps refresh them for every session |
| `ICE_SERVERS_JSON` | — | Full override: a JSON array of `RTCIceServer` objects |
| `MAX_CLIENTS` | `20000` | Maximum simultaneous devices |
| `MAX_CONNECTIONS_PER_IP` | `50` | Connections allowed from one IP address |
| `NEW_DEVICES_PER_HOUR` | `60` | New device IDs one network (IPv4 address or IPv6 /64) may register per hour (bursts up to twice that); `0` = unlimited |
| `NEW_DEVICES_GLOBAL_PER_HOUR` | `10000` | New device IDs the whole server accepts per hour; `0` = unlimited |
| `MAX_DEVICES` | `1000000` | Maximum remembered device IDs; new devices are refused beyond it (IDs unused for a year are forgotten) |
| `DOWNLOAD_URL` | GitHub releases | Where "Install the desktop app" links point |

Endpoints: `/` web app · `/ws` WebSocket · `/healthz` health check · `/api/info` server name, version, TURN availability.

### TURN without running coturn

Any standards-compliant TURN service works. Examples:

```bash
# Static credentials (e.g. from a hosted TURN provider)
TURN_URLS=turns:turn.provider.example:443?transport=tcp,turn:turn.provider.example:3478
TURN_USERNAME=...
TURN_PASSWORD=...

# Or hand the apps a complete list
ICE_SERVERS_JSON='[{"urls":"stun:stun.cloudflare.com:3478"},{"urls":["turn:turn.example.com:3478"],"username":"u","credential":"p"}]'
```

---

## Point the apps at your server

- **Browser version:** just open your server's address — it connects to itself automatically.
- **Desktop app:** Settings → Network → *Server address* → `desk.example.com` → **Save and reconnect**.
- **Your own installers with the address built in** (best for non-technical users):
  1. In your fork on GitHub: Settings → Secrets and variables → Actions → **Variables** → add `BEAMDESK_SERVER_URL` = `https://desk.example.com`.
  2. Push a tag: `git tag v1.0.0 && git push origin v1.0.0`.
  3. The *Release desktop apps* workflow builds Windows, macOS and Linux installers and publishes them on your Releases page. Users install and see **Ready** — nothing to configure.
- **Managed computers:** place a `beamdesk.json` file next to the BeamDesk executable, or in the app's data folder
  (`%APPDATA%\BeamDesk` on Windows, `~/Library/Application Support/BeamDesk` on macOS, `~/.config/BeamDesk` on Linux):

  ```json
  { "serverUrl": "https://desk.example.com", "accessKey": "optional-key" }
  ```

---

## Private servers

Set `ACCESS_KEY` to a long random string (`openssl rand -hex 24`). Devices without the key are refused at registration, so strangers cannot use your server or your TURN relay. Give the key to your users (Settings → Network → *Access key*), put it in `beamdesk.json`, or distribute pre-configured installers.

---

## Operations

- **Health:** `GET /healthz` returns `{"ok":true,"online":<devices>}` — use it for uptime monitoring.
- **Backups:** only `DATA_DIR/devices.json` matters. It maps IDs to device keys so nobody can take over an existing ID. Losing it is not dangerous; IDs are simply claimable again by the first device that registers them (and every device still verifies the other side's key end to end).
- **Logs:** the server logs startup information and errors only. It never logs connection contents.
- **Scaling:** one instance handles tens of thousands of idle devices. Signaling is in-memory, so run a single instance per server address (put several servers behind different addresses if you need more).
- **Security hardening:** keep the image updated, restrict SSH, and leave the coturn private-network deny rules in place.
