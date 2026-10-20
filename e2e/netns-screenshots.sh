#!/bin/sh
# Regenerates the host mode screenshots (e2e/hostmode.screenshots.ts) inside a private network
# namespace: a virtual network card with a home address (192.168.1.20), and the fake router's
# address (192.168.1.1) on its other end, which BeamDesk ignores like any virtual adapter.
# Linux only; needs unshare (util-linux), iproute2, xvfb, dbus and gnome-keyring.
# Run `npm run build` first.
set -eu
cd "$(dirname "$0")/.."
exec unshare -rn sh -c '
  set -eu
  ip link set lo up
  ip link add eth0 type veth peer name br-router
  ip addr add 192.168.1.20/24 dev eth0
  ip addr add 192.168.1.1/32 dev br-router
  ip link set eth0 up
  ip link set br-router up
  ip route add default dev eth0
  unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy ALL_PROXY all_proxy
  export BEAMDESK_SHOTS_NETNS=1
  dbus-run-session -- sh -c "echo | gnome-keyring-daemon --unlock --components=secrets >/dev/null &&
    xvfb-run -a -s \"-screen 0 1280x820x24\" npx playwright test -c e2e/screenshots.config.ts hostmode.screenshots.ts"
'
