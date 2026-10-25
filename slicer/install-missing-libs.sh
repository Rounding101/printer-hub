#!/bin/sh
# Usage: install-missing-libs.sh <extracted AppImage dir>
# Resolves "not found" shared libraries of the Orca binary to Ubuntu packages.
set -eu
root="$1"
bin="$root/bin/orca-slicer"
# AppRun points LD_LIBRARY_PATH at the libraries bundled in the AppImage.
libpath="$root/lib:$root/usr/lib:$root/lib/x86_64-linux-gnu"

missing() { LD_LIBRARY_PATH="$libpath" ldd "$bin" | awk '/not found/ {print $1}' | sort -u; }

apt-get update >/dev/null
apt-file update >/dev/null
for round in 1 2 3 4; do
  libs=$(missing)
  [ -z "$libs" ] && break
  echo "Round $round, missing: $libs"
  pkgs=""
  for lib in $libs; do
    pkg=$(apt-file search -x "/$lib\$" 2>/dev/null | awk -F: '{print $1}' | grep -v -- '-dev$' | grep -v -- '-dbg' | head -n1 || true)
    if [ -n "$pkg" ]; then pkgs="$pkgs $pkg"; else echo "  no package provides $lib"; fi
  done
  [ -z "$pkgs" ] && break
  echo "Installing:$pkgs"
  # shellcheck disable=SC2086
  apt-get install -y --no-install-recommends $pkgs >/dev/null
done

left=$(missing)
rm -rf /var/lib/apt/lists/*
if [ -n "$left" ]; then
  echo "Still missing after install: $left" >&2
  exit 1
fi
echo "All shared libraries resolved."
