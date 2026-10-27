#!/bin/sh
# Usage: install-missing-libs.sh <extracted AppImage dir>
# Resolves "not found" shared libraries of the Orca binary to Ubuntu packages.
# Best effort: anything ldd still flags is reported, not fatal. Some flagged
# libraries are only used by the GUI, and the build's self-test (an actual
# slice for each printer) decides whether the image works.
set -u
root="$1"
bin="$root/bin/orca-slicer"
# AppRun points LD_LIBRARY_PATH at the libraries bundled in the AppImage.
libpath="$root/lib:$root/usr/lib:$root/lib/x86_64-linux-gnu"

missing() { LD_LIBRARY_PATH="$libpath" ldd "$bin" 2>/dev/null | awk '/not found/ {print $1}' | sort -u; }

libs=$(missing)
if [ -z "$libs" ]; then echo "All shared libraries resolved."; exit 0; fi
echo "Missing before lookup: $libs"

apt-get update -q || echo "apt-get update reported errors (continuing)"
apt-file update || echo "apt-file update reported errors (continuing)"

for round in 1 2 3 4; do
  libs=$(missing)
  [ -z "$libs" ] && break
  echo "== Round $round, missing: $libs"
  for lib in $libs; do
    pkg=$(apt-file search -x "/$lib\$" 2>/dev/null | awk -F: '{print $1}' | grep -v -e '-dev$' -e '-dbg' -e 'dbgsym' | head -n1)
    if [ -z "$pkg" ]; then echo "  $lib: no package found"; continue; fi
    echo "  $lib -> $pkg"
    apt-get install -y --no-install-recommends "$pkg" >/tmp/apt.log 2>&1 || { echo "  install of $pkg failed:"; tail -n 5 /tmp/apt.log; }
  done
done

left=$(missing)
rm -rf /var/lib/apt/lists/* /tmp/apt.log
if [ -n "$left" ]; then
  echo "WARNING: still missing after install (the self-test decides if that matters): $left"
else
  echo "All shared libraries resolved."
fi
exit 0
