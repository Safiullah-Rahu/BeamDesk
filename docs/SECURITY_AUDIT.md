# Security audit — October 2026

An internal review of the whole BeamDesk code base before the first release: the signaling
server, the connection protocol, file transfer, the web app, the Electron desktop app, the
deployment files and the CI/release pipeline.

**Result:** 32 issues found, all fixed. One was critical (anyone could crash a public server
with a single message before logging in). Every fix has a regression test; the attacks were
re-run against the fixed code.

- [Method](#method)
- [Findings](#findings)
- [How the fixes were verified](#how-the-fixes-were-verified)
- [Remaining risks](#remaining-risks)

## Method

The review assumed four kinds of attacker:

| Attacker | Can do |
|---|---|
| **Anyone on the internet** | Talk to a public BeamDesk server; know or guess device IDs |
| **The server itself** (malicious, compromised, or a network attacker in front of it) | Read, drop, change and inject every signaling message |
| **The other side of a session** | A "helper" who wants more than they were given, or a "customer" luring a helper |
| **Code in the app's page** (e.g. a future XSS bug) | Call everything the desktop app's bridge offers |

Techniques: line-by-line review of every module, a fuzzing harness against the real server
bundle (malformed, oversized, binary, deeply nested and flooding messages, path traversal,
slow requests), a man-in-the-middle relay that tampers with real browser sessions, and
inspection of the packaged desktop app.

## Findings

Severity follows the impact on users: **Critical** — remote and unauthenticated, affects
everyone; **High** — break-in, impersonation or scams against a user; **Medium** — needs a special
position or gives a partial foothold; **Low** — defence in depth.

### Server

| # | Severity | Issue | Fix |
|---|---|---|---|
| S1 | **Critical** | A single WebSocket message with ~20 000 nested brackets crashed the server process (stack overflow while reading a field) **before authentication**, disconnecting every device. Repeatable at will. | Messages nested deeper than 16 levels are refused before parsing; fields are type-checked instead of converted; every message is handled in a guard that logs and closes only the offending connection. |
| S2 | Medium | Slow HTTP requests (half-sent headers) were never timed out (the timeouts were set in a way Node ignores), so a few clients could exhaust the server ("slowloris"). | Header/request/keep-alive timeouts passed to the server constructor; verified: a stalled request is answered with 408 after ~17 s. |
| S3 | Medium | Resource exhaustion: every connection could try unlimited registrations (expensive signature checks); limits per IPv6 *address* were trivial to bypass with one /64; no global cap on new device IDs or registry size; no back-pressure for clients that stop reading (server memory grew). | One registration attempt per connection; limits per IPv4 address / IPv6 /64; new-connection rate per network; global hourly budget and maximum registry size; expired IDs pruned; outgoing queue capped per client, slow clients disconnected. |
| S4 | Medium | ID scanning: presence queries and "offline" answers revealed which IDs are online at a high rate. | Both are rate limited per connection. |
| S5 | Low | Pages served over HTTPS still allowed plain `ws:`/`http:` connections; no HSTS. | Strict `connect-src` and HSTS when the request arrived over HTTPS. |
| S6 | Low | Behind more than one reverse proxy, all clients shared one rate-limit key (or could choose their own). | `TRUST_PROXY` accepts the number of proxies. |

### Connection protocol

| # | Severity | Issue | Fix |
|---|---|---|---|
| P1 | **High** | **Password downgrade.** The host's password offer was not signed, so whoever relayed the handshake could remove it. A viewer who typed a password would then be let in by an accept prompt or auto-accept, without the device ever proving it knows the password — combined with an impostor device on a first connection, a user could connect to an attacker's computer believing it was their own. | The offer is part of the host's signature (protocol v2). A viewer that gave a password for a device it has never verified requires the device to prove the password and stops otherwise. |
| P2 | **High** | **Files and clipboard pushed to the helper.** The device being helped decides the file and clipboard permissions, so a malicious "customer" could drop files (e.g. `setup.exe`) into the helper's downloads and overwrite the helper's clipboard at any moment (swapping a copied bank account number, for example). | The viewer asks before saving every file, and applies remote clipboard content only while the user is looking at that session. |
| P3 | **High** | **Fake "is sharing their screen with you" invites.** Anyone could send an invite to any ID, e.g. as "Microsoft Support", to lure a helper into a session on the attacker's screen. | Help links carry a random token; only invites echoing a token from a link this device created are shown. |
| P4 | Medium | **Lockout of the owner.** Five wrong passwords from anyone locked password logins for everyone for five minutes, repeatable — a stranger could keep the owner out of their own unattended computer. | Lockout per requesting device (5 tries / 15 min), plus a larger global budget against distributed guessing that the owner's trusted devices bypass. |
| P5 | Medium | **One-time password reusable during a session.** It was replaced only when the session ended, and stayed on screen — so the connected person could read it and come back later without being asked. | The password is spent the moment it lets someone in; while someone is connected it is hidden and left out of invite links. |
| P6 | Medium | The server could end or stall live sessions by injecting "bye"/"pending" messages. | Once the encrypted channel is up only messages on it count. |
| P7 | Low | The viewer revealed its IP addresses (ICE candidates) before the host had proven its identity. | Held back until the host's signature is verified. |
| P8 | Low | One device could trigger unlimited accept prompts; strangers could fill the queue of waiting requests so the owner's own devices were turned away. | Three prompts per device per 10 minutes; trusted devices get extra queue slots; the session limit is enforced again when a request is accepted. |
| P9 | Low | Untrusted peer data was used too directly: quality values went into the video encoder unclamped, display lists and permissions were not validated (`"yes"` counted as granted), a key name like `constructor` resolved to an object, chat history was unbounded, unknown close reasons and notices from the other device were shown as if they were BeamDesk's own text. | All control messages are normalised and clamped; permissions must be real booleans; key lookups use own properties only; chat history is capped; unknown reasons show a generic message; notices are labelled "‹device› says: …". |
| P10 | Low | Session IDs chosen by the viewer were not restricted, so they could contain the separator used in signed transcripts. | Session IDs must match `[A-Za-z0-9_-]{8,64}`. |

### File transfer

| # | Severity | Issue | Fix |
|---|---|---|---|
| F1 | Medium | The sender streamed file data before the receiver had accepted it; unlimited files could be in flight at once; every refused file was still recorded (an endless list); the browser version buffered any size in memory. | Data flows only after the receiver accepts; at most 4 incoming files at once; refusals leave no record; the list is capped; browser downloads are capped at 1 GiB. |
| F2 | Medium | Dangerous files were not recognisable: `invoice.pdf          .exe` hid its real extension, shortcut files (`.lnk`, `.url`, `.scf`…) can leak Windows credentials just by appearing in a folder, and received files did not carry the "downloaded from the internet" mark that makes Windows/macOS warn before running them. | Whitespace runs are collapsed; programs, scripts and installers are flagged in the consent dialog (and always need consent on the host); shortcut/link files are refused; files get `Zone.Identifier` (Windows) or the quarantine attribute (macOS). |

### Web app

| # | Severity | Issue | Fix |
|---|---|---|---|
| A1 | Low | A "wrong password" result — which is not authenticated — deleted the saved password, so anyone in between could wipe it. | Saved passwords are only replaced by the user. |
| A2 | Low | Reconnecting a session opened from a link dropped the link's key pin; after an identity failure, "Reconnect" retried blindly. | Reconnects keep the pin; security failures show a warning instead of a retry button. |
| A3 | Low | Help links gave the helper clipboard and file access by default, and an unused approval stayed valid after the person stopped sharing. | Only screen (and control on desktop) by default, with switches for the rest; approvals are withdrawn when sharing stops. |
| A4 | Low | Names from links and invites were not sanitised like other names (bidi/control characters could spoof text). | Same sanitising everywhere. |

### Desktop app

| # | Severity | Issue | Fix |
|---|---|---|---|
| D1 | Medium | Electron "fuses" were left at defaults, so the signed app could be started as a plain Node.js interpreter (`ELECTRON_RUN_AS_NODE`), with `NODE_OPTIONS`/`--inspect`, or with a modified `app.asar` — useful to malware that wants to hide behind a trusted, permitted app. | Fuses flipped at build time (run-as-node, NODE_OPTIONS and inspect off; asar integrity validation and asar-only loading on). Verified on the packaged build. |
| D2 | Medium | The page could change the download folder through the settings store — for example to the Startup folder, turning a received file into code that runs at the next login. | The folder can only be chosen through the folder picker in the main process; a stored value is validated. |
| D3 | Medium | Origin checks used prefixes (`app://beamdesk…`, `http://localhost:5173…`), and a development URL from the environment was honoured by packaged apps. | Exact origin comparison for IPC, permissions and navigation; top-level frames only; development URL ignored when packaged. |
| D4 | Medium | The desktop UI (which can reach the native bridge) was served without a Content Security Policy. | Strict CSP on every `app://` response. |
| D5 | Medium | The main process injected any mouse/keyboard input the page sent, whether or not a session allowed control. | Input is only injected while a session with control permission is active (and visible in the session bar). |
| D6 | Medium | macOS entitlements allowed loading unsigned libraries and unsigned executable memory, and requested Apple Events automation that BeamDesk does not use. | Only JIT and network entitlements remain; ad-hoc builds use no hardened runtime, signed builds keep library validation. |
| D7 | Low | Screen lock: Windows looked up `rundll32.exe` via the search path (current folder first); on macOS it only locked when "require password after sleep" was set; nothing locked if the UI crashed during a session. | Absolute system path; Ctrl+Cmd+Q on macOS; lock after a crash mid-session when "lock when a session ends" is on. |
| D8 | Low | Without a system keyring (some Linux desktops) secrets were stored unencrypted without telling the user. | A notice explains it and how to fix it. |

### Deployment and release

| # | Severity | Issue | Fix |
|---|---|---|---|
| C1 | Medium | The release workflow gave every build job (running thousands of third-party packages) a token that can write to the repository and releases, with git credentials left on disk. | Build jobs are read-only and keep no credentials; a separate publish job without project code uploads the files and a `SHA256SUMS.txt`; Dependabot watches npm, Actions and Docker. |
| C2 | Medium | The TURN relay allowed TCP relaying and missed several internal ranges (IPv4-mapped IPv6, NAT64, IPv6 link-local, benchmarking and reserved ranges), so it could be used to reach services inside the host's network; its secret was visible on the process command line; the example config shipped a placeholder secret the server accepted; TURN credentials lived 12 hours. | UDP-only relaying to public addresses, per-session bandwidth cap, secret moved to a private config file, server refuses to start with a missing/short/placeholder secret, credentials live 1 hour. |

## How the fixes were verified

- **46 unit and integration tests** (`npm test`), including new ones for the crash, binary/oversized/malformed messages, one registration per connection, IPv6 grouping, configuration refusal, file consent, early data, concurrent file limits, misleading file names and PBKDF2 equivalence.
- **Fuzzing harness** against the bundled server: 13 checks (malformed and oversized frames, floods, unregistered access, idle sockets, per-IP limits, path traversal, methods, headers, upgrade paths, slow headers, health). Before the fix the first nested-JSON message killed the process; after it, all 13 pass.
- **Attack tests through a tampering relay** (`e2e/security.spec.ts`, real browsers and real WebRTC): swapped DTLS certificate → refused before anything is shared; forged acceptance → refused; stripped password offer → refused; injected hang-up and "pending" → session stays up; unsolicited and guessed-token invites → not shown; file from the other side → consent dialog, flagged, decline honoured, nothing downloaded; password on a device that cannot prove it → stopped, with a safe fallback.
- **Existing end-to-end tests** (browser↔browser and desktop app as host) pass with the changes; the desktop test now also covers the host-side consent for a risky file.
- **Packaged desktop build** (Linux) inspected: starts and connects normally with the new CSP; `ELECTRON_RUN_AS_NODE=1` no longer turns it into a Node.js interpreter.

## Remaining risks

These are known and documented in the [security model](SECURITY_MODEL.md#limitations):

- A first connection by typed ID with neither password nor link trusts the server for the 9-digit ID → key mapping. Links, passwords and the security code remove this.
- A server can always refuse service (drop messages, or answer "declined"); refusals are not signed because they grant nothing.
- The server sees metadata: who connects to whom, when, and from which IP addresses.
- If the desktop app's page were ever compromised, it could still act within an active session (that is what the page is for); the main process limits it to sessions the user can see.
- Builds without a code-signing certificate show OS warnings and cannot use the macOS hardened runtime.
