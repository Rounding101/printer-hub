#!/bin/sh
# Printer Hub installer / updater.
#
#   curl -fsSL https://raw.githubusercontent.com/Shawman511/printer-hub/main/install.sh | sh
#
# Puts docker-compose.yml in ~/printer-hub (or $PRINTER_HUB_DIR), starts the
# containers, waits until the hub is up, and prints its address and the
# first-run setup code. Run it again any time to update. Settings you change
# go in ~/printer-hub/.env, which is kept.
set -eu

RAW=${PRINTER_HUB_RAW:-https://raw.githubusercontent.com/Shawman511/printer-hub/main}
DIR=${PRINTER_HUB_DIR:-$HOME/printer-hub}

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else die "Needs curl or wget to download files."
  fi
}

step "Checking Docker"
command -v docker >/dev/null 2>&1 \
  || die "Docker isn't installed. Install it (https://docs.docker.com/engine/install/), then run this again."
docker compose version >/dev/null 2>&1 \
  || die "'docker compose' isn't available. Install the Docker Compose plugin (https://docs.docker.com/compose/install/), then run this again."
docker info >/dev/null 2>&1 \
  || die "Can't reach Docker. Is it running? If it is, give your user access with
  sudo usermod -aG docker \$USER
then log out and back in (or run this installer with sudo)."
say "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') with $(docker compose version --short 2>/dev/null || echo 'compose')"

step "Getting Printer Hub into $DIR"
mkdir -p "$DIR"
cd "$DIR"
fetch "$RAW/deploy/docker-compose.yml" docker-compose.yml
if [ ! -f .env ]; then
  tz=$(cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##' || true)
  printf 'HUB_PORT=%s\nTZ=%s\n' "${HUB_PORT:-3000}" "${tz:-UTC}" > .env
  say "Wrote .env (port ${HUB_PORT:-3000}, time zone ${tz:-UTC})"
fi
port=$(sed -n 's/^HUB_PORT=//p' .env | tail -n 1)
port=${port:-3000}

# OrcaSlicer only has x86-64 Linux builds; elsewhere run the hub without it.
case "$(uname -m)" in
  x86_64 | amd64) rm -f docker-compose.override.yml ;;
  *)
    say "This is a $(uname -m) machine: slicing needs x86-64, so the slicer is left out."
    say "Everything else works, and you can upload G-code sliced on your computer."
    cat > docker-compose.override.yml <<'EOF'
# Written by install.sh: no slicer on this (non-x86) machine.
services:
  slicer:
    profiles: ["no-slicer"]
  printer-hub:
    environment:
      SLICER_URL: ""
EOF
    ;;
esac

step "Downloading images (the first time takes a few minutes)"
docker compose pull
step "Starting"
docker compose up -d --remove-orphans

printf 'Waiting for the hub'
i=0
until [ "$(docker inspect --format '{{.State.Health.Status}}' printer-hub 2>/dev/null)" = healthy ]; do
  i=$((i + 1))
  [ "$i" -gt 90 ] && die "The hub didn't come up within 3 minutes. See: cd $DIR && docker compose logs printer-hub"
  printf '.'
  sleep 2
done
say ' ready.'

ip=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$ip" ] || ip=$(ipconfig getifaddr en0 2>/dev/null || true)
[ -n "$ip" ] || ip=localhost
code=
# Only while no admin exists yet (an old code may still be in the log).
if docker compose exec -T printer-hub wget -qO- http://127.0.0.1:3000/api/auth/me 2>/dev/null | grep -q '"setup":true'; then
  code=$(docker compose logs printer-hub 2>/dev/null | sed -n 's/.*setup code \([0-9A-Z]\{5\}-[0-9A-Z]\{5\}\).*/\1/p' | tail -n 1)
fi

step "Printer Hub is running"
say "  Open:        http://$ip:$port"
if [ -n "$code" ]; then
  say "  Setup code:  $code   (enter it on the first page to create your admin account)"
else
  say "  Sign in with your existing account."
fi
say ""
say "  Then add your printers under Settings -> Printers."
say "  Update later by running this installer again. Files are in $DIR."
