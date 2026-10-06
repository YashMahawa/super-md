#!/usr/bin/env bash
# Run in a disposable official distro container; never install into the host.
set -euo pipefail
version="$1"
source /etc/os-release
if [[ "$ID" == fedora ]]; then
  dnf -y install python3 xorg-x11-server-Xvfb xauth shadow-utils mesa-libEGL mesa-libGL nss alsa-lib mesa-libgbm fontconfig dbus-libs
  dnf -y install "/packages/Super-MD-${version}-1.x86_64.rpm"
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  sound=libasound2
  if apt-cache show libasound2t64 >/dev/null 2>&1; then sound=libasound2t64; fi
  apt-get install -y --no-install-recommends python3 xvfb xauth weston dbus-x11 \
    libegl1 libgl1 libgl1-mesa-dri libnss3 "$sound" libgbm1 libxkbcommon-x11-0 libxcb-cursor0 fontconfig
  apt-get install -y "/packages/Super-MD_${version}_amd64.deb"
fi
useradd --create-home supermdtest
# A fresh non-root user, no Python packages/venv, no host GPU, no Qt developer
# install, no user's config and no --no-sandbox workaround.
runuser -u supermdtest -- xvfb-run -a python3 /checks/check_packaged.py /opt/super-md/super-md "$version" --graphics auto
runuser -u supermdtest -- xvfb-run -a python3 /checks/check_packaged.py /opt/super-md/super-md "$version" --graphics software
runuser -u supermdtest -- xvfb-run -a python3 /checks/check_packaged.py "/packages/Super-MD_${version}_amd64.AppImage" "$version" --graphics software
if [[ "$ID" != fedora ]]; then
  runuser -u supermdtest -- bash -s -- "$version" <<'WAYLAND'
set -euo pipefail
export XDG_RUNTIME_DIR
XDG_RUNTIME_DIR=$(mktemp -d /tmp/supermd-wayland-test.XXXXXX)
chmod 700 "$XDG_RUNTIME_DIR"
export WAYLAND_DISPLAY=supermd-wayland
renderer=(--use-pixman)
if [[ "$(weston --help 2>&1)" == *"--renderer"* ]]; then renderer=(--renderer=pixman); fi
weston --backend=headless-backend.so "${renderer[@]}" --socket="$WAYLAND_DISPLAY" --idle-time=0 \
  --width=1440 --height=1000 --log="$XDG_RUNTIME_DIR/weston.log" &
weston_pid=$!
trap 'kill "$weston_pid" 2>/dev/null || true' EXIT
for attempt in {1..50}; do [[ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]] && break; sleep .1; done
[[ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]] || { cat "$XDG_RUNTIME_DIR/weston.log"; exit 1; }
python3 /checks/check_packaged.py /opt/super-md/super-md "$1" --graphics missing-wayland-egl
python3 /checks/check_packaged.py "/packages/Super-MD_${1}_amd64.AppImage" "$1" --graphics missing-wayland-egl
WAYLAND
fi
