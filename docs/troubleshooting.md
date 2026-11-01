# Troubleshooting

[← Back to the README](../README.md)

Start with the hub's log; most problems are explained there:

```bash
docker logs --tail 100 printer-hub
docker logs --tail 100 printer-hub-slicer
```

## Getting started

**I don't have the setup code.**
It's printed when the hub starts with no admin account:
`docker logs printer-hub 2>&1 | grep "setup code" | tail -n 1`. A restart makes a new
code, so use the last one. If the log is empty, restart the container
(`docker restart printer-hub`) and look again. If the page asks you to sign in
instead, an admin account already exists; see the next question.

**The port is already in use.**
Set another one with `HUB_PORT=8080` in the `.env` file next to the compose file
(or `HUB_PORT=8080` before the installer's `sh`), then `docker compose up -d`.

**`docker: permission denied` on the socket.**
Your user isn't in the `docker` group: `sudo usermod -aG docker $USER`, then log
out and back in, or run the commands with `sudo`.

**I forgot the admin password.**
Set the environment variable `HUB_RESET_PASSWORD=<username>` on the
`printer-hub` container and restart it. The log shows a new random password.
Sign in, change it under your name (top right), then remove the variable.

**The page doesn't load.**
Check the container is running and healthy (`docker ps`), that you're using the
right port (`HUB_PORT`, 3000 by default), and that no firewall on the machine
blocks it. Another program already using the port shows as "port is already
allocated" when the container starts: pick another `HUB_PORT`.

## Printers

**"Couldn't connect" when testing a printer.**
- The hub's machine must reach the printer's address: try
  `ping <printer IP>` from that machine. Printers on a separate VLAN or guest
  WiFi need a firewall rule allowing it.
- The printer must be in its local/LAN mode (FlashForge LAN-only mode, Anycubic
  LAN Mode, PrusaLink turned on, OctoPrint connected to the printer).
- Check the port: Moonraker uses 7125, OctoPrint usually 80 (or 5000), Prusa 80.

**"refused the API key" / "refused the password".**
Copy the key or password again from the printer or OctoPrint. In the edit
form, an empty password field keeps the saved one; type it to replace it.

**A printer shows offline after its IP changed.**
Edit it under Settings → Printers and enter the new address. Give printers a
DHCP reservation in your router so it doesn't happen again.

**FlashForge AD5M: status works, but light, files and starting prints don't.**
Enter the serial number and check code in the printer's settings. Without them
the hub can only use the older, more limited connection.

**Anycubic: "Printer is in cloud mode".**
Turn on LAN Mode on the printer (Settings → Network).

## Camera

**"No camera" on a printer that has one.**
- Klipper: the camera must be set up in Mainsail/Fluidd (Moonraker's webcam
  settings), or enter its stream URL in the printer's settings.
- OctoPrint: the webcam must be enabled in OctoPrint's settings.
- Any printer: you can enter an MJPEG stream URL (e.g.
  `http://192.168.1.60/webcam/?action=stream`) in the printer's settings.

## Slicing

**"Slicer offline" in the library.**
The `printer-hub-slicer` container isn't running or the hub can't reach it.
Check `docker ps` and its log. On a Raspberry Pi or other ARM machine there is
no slicer (OrcaSlicer only runs on x86-64).

**"No slicer profile for …", or the printer is missing from the Slice dialog.**
Edit the printer under Settings → Printers and pick its **Slice with**
profile. For printers OrcaSlicer doesn't list, use **Custom → MyKlipper** or
**MyMarlin** with your nozzle size.

**"Slicing failed".**
The message includes Orca's reason. Common ones: the model is bigger than the
bed, or it's floating (try **Auto-orient**). Very thin parts can produce empty
layers.

## Docker

**"no space left on device" or apt errors (exit code 100) when building.**
The disk is full. Old images and build cache add up with every update:
`docker system df` shows usage, and `docker image prune -af` and
`docker builder prune -af` free it. Using the published images (the installer
or `deploy/docker-compose.yml`) avoids building altogether.

**"no matching manifest for linux/arm64" for the slicer.**
OrcaSlicer only runs on x86-64. Remove the `slicer` service on ARM machines
(see [Installation](installation.md#raspberry-pi-and-other-arm-machines)).

## Still stuck?

[Open an issue](https://github.com/Shawman511/printer-hub/issues/new/choose)
with your printer model, the hub version (top bar) and the relevant log lines.
