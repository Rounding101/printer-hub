# Installation

[← Back to the README](../README.md)

Printer Hub runs in Docker on any always-on machine on the same network as
your printers: a home server, a NAS, a mini PC or a Raspberry Pi.

- [Before you start](#before-you-start)
- [Option 1: the installer](#option-1-the-installer-linux-macos-nas-raspberry-pi)
- [Option 2: Docker Compose](#option-2-docker-compose)
- [Option 3: one `docker run`](#option-3-one-docker-run-no-slicer)
- [Windows](#windows-docker-desktop)
- [Portainer, Unraid, TrueNAS, Dockhand and other Docker UIs](#portainer-unraid-truenas-dockhand-and-other-docker-uis)
- [Raspberry Pi and other ARM machines](#raspberry-pi-and-other-arm-machines)
- [First sign-in](#first-sign-in)
- [Updating, backups and uninstalling](#updating)
- [HTTPS and remote access](#https-and-remote-access)
- [Settings reference](#settings-reference)

## Before you start

- **Docker** with the Compose plugin
  ([install guide](https://docs.docker.com/engine/install/)). Check with
  `docker compose version`.
- About **3 GB** of free disk space (the slicer image is the big one) and 1 GB
  of RAM.
- The machine must be able to reach your printers' IP addresses. Give each
  printer a fixed address (a DHCP reservation in your router).

## Option 1: the installer (Linux, macOS, NAS, Raspberry Pi)

```bash
curl -fsSL https://raw.githubusercontent.com/Shawman511/printer-hub/main/install.sh | sh
```

It checks Docker, puts the compose file in `~/printer-hub`, starts the
containers, waits until the hub is up, and prints the address and your
one-time setup code. On ARM machines it leaves the slicer out (see
[below](#raspberry-pi-and-other-arm-machines)). Re-run it any time to update.

You can [read the script](../install.sh) first. To choose the folder or port:

```bash
curl -fsSL https://raw.githubusercontent.com/Shawman511/printer-hub/main/install.sh | PRINTER_HUB_DIR=/opt/printer-hub HUB_PORT=8080 sh
```

## Option 2: Docker Compose

```bash
mkdir printer-hub && cd printer-hub
curl -fsSLO https://raw.githubusercontent.com/Shawman511/printer-hub/main/deploy/docker-compose.yml
docker compose up -d
```

The [compose file](../deploy/docker-compose.yml) runs two containers:

| Container | Image | What it does |
| --- | --- | --- |
| `printer-hub` | `ghcr.io/shawman511/printer-hub` | The web app, on port 3000 |
| `printer-hub-slicer` | `ghcr.io/shawman511/printer-hub-slicer` | OrcaSlicer, for slicing models (only reachable by the hub) |

Both keep their data in the `printer-hub-data` volume. Put settings in a `.env`
file next to the compose file:

```bash
HUB_PORT=3000          # port on this machine
TZ=Europe/London       # your time zone, for the job log
HUB_VERSION=0.11.0     # pin a release instead of "latest" (optional)
```

## Option 3: one `docker run` (no slicer)

Just the hub, without slicing (you can still upload G-code sliced on your
computer):

```bash
docker run -d --name printer-hub --restart unless-stopped -p 3000:3000 -v printer-hub-data:/data ghcr.io/shawman511/printer-hub:latest
```

## Windows (Docker Desktop)

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/),
then in PowerShell:

```powershell
mkdir printer-hub; cd printer-hub
curl.exe -fsSLO https://raw.githubusercontent.com/Shawman511/printer-hub/main/deploy/docker-compose.yml
docker compose up -d
```

## Portainer, Unraid, TrueNAS, Dockhand and other Docker UIs

Create a **stack** (or "compose project") and paste the contents of
[`deploy/docker-compose.yml`](../deploy/docker-compose.yml). Set `HUB_PORT` and
`TZ` as stack environment variables if you want to change them.

To build from source instead (e.g. to run unreleased changes), point a Git
stack at this repository and its root [`compose.yaml`](../compose.yaml). The
first build takes 10–15 minutes.

## Raspberry Pi and other ARM machines

The hub image is built for ARM (64-bit), but OrcaSlicer only publishes x86-64
Linux builds, so the slicer can't run there. The installer handles this for
you. With Compose, delete the `slicer` service and the `SLICER_URL` line from
the compose file. Everything except slicing in the hub works: print files you
sliced on your computer can be uploaded, sent and started as usual.

## First sign-in

1. Open `http://<the machine's IP>:3000`.
2. Enter the **setup code** to create the admin account. The installer prints
   it; otherwise run:
   ```bash
   docker logs printer-hub 2>&1 | grep "setup code"
   ```
3. Click **Add a printer**. See [Printers](printers.md) for what to enter for
   each type.

Add more people under **Settings → Users** (admin, operator or watch-only
viewer); see [Users and security](users-and-security.md).

## Updating

- Installer: run it again.
- Compose: `docker compose pull && docker compose up -d`
- `docker run`: `docker pull ghcr.io/shawman511/printer-hub:latest`, then
  remove and re-create the container with the same command.

Your accounts, printers, library and job log are kept (they're in the volume).
The version is shown in the app's top bar; [CHANGELOG.md](../CHANGELOG.md)
lists what changed.

## Backups

Everything is in the `printer-hub-data` volume (`/data` in the containers):
`printers.json`, `auth.json`, `jobs.json`, `spools.json` and `library/`. To
back it up:

```bash
docker run --rm -v printer-hub-data:/data -v "$PWD":/backup alpine tar czf /backup/printer-hub-backup.tgz -C /data .
```

Restore by extracting the archive into the volume while the hub is stopped.

## Uninstalling

```bash
cd ~/printer-hub && docker compose down          # stop and remove the containers
docker volume rm printer-hub-data                 # also delete all data (careful)
```

## HTTPS and remote access

Keep the hub on your home network. To use it from outside, use a VPN such as
WireGuard or Tailscale rather than opening a port.

Behind a reverse proxy (Caddy, Nginx Proxy Manager, Traefik), proxy to port
3000, keep Server-Sent Events unbuffered (needed for live updates), and set
`TRUST_PROXY=true` on the hub so failed sign-ins are counted per real client.
The session cookie is marked Secure automatically when the proxy sends
`X-Forwarded-Proto: https`.

## Settings reference

Environment variables for the `printer-hub` container:

| Variable | Default | |
| --- | --- | --- |
| `TZ` | `UTC` | Time zone for the job log |
| `SLICER_URL` | `http://slicer:8080` in the compose file | Slicer service; empty turns slicing off |
| `TRUST_PROXY` | `false` | Read the client address from `X-Forwarded-For` |
| `HUB_RESET_PASSWORD` | | A username: sets a new random password for it at startup (shown in the log). Remove afterwards |
| `PORT` | `3000` | Port inside the container |
| `DATA_DIR` | `/data` | Where data is stored |

Printers themselves are set up in the app. For scripted setups, mount a JSON
file and point `CONFIG_PATH` at it. Printers listed there are imported once, on
the very first start (after that, `data/printers.json` and the Settings page
take over):

```json
{
  "pollIntervalMs": 3000,
  "printers": [
    { "id": "voron", "name": "Voron 2.4", "type": "moonraker", "host": "192.168.1.60" },
    { "id": "ender", "name": "Ender 3", "type": "octoprint", "host": "octopi.local", "apiKey": "${OCTOPRINT_KEY}" }
  ]
}
```

`type` is one of `moonraker`, `octoprint`, `prusalink`, `flashforge`,
`anycubic` or `mock`, followed by that type's settings. `"${NAME}"` is replaced
by the environment variable `NAME`. `pollIntervalMs` sets how often printers
are asked for their status.
