# Development

[← Back to the README](../README.md)

## Run it locally

```bash
git clone https://github.com/Shawman511/printer-hub.git
cd printer-hub
npm install
npm run demo                  # two simulated printers, no hardware
node test/fake-printers.js    # fake Klipper, OctoPrint and PrusaLink printers to add in Settings
npm test                      # driver and API tests
```

`npm start` runs with your own `config.json` (created from
`config.example.json`). Slicing needs the `slicer` container:
`docker compose up -d --build` builds and runs both from source.

## How it works

- `server.js` polls or subscribes to each printer and pushes changes to the
  browser over Server-Sent Events (`/api/events`).
- Camera and thumbnail traffic goes through the server
  (`/api/printers/:id/camera`), so the browser only ever talks to port 3000.
- Printers are stored in `data/printers.json` and edited in Settings; each
  runs a driver from `drivers/`, one file per printer type.
- **Adding a printer type:** extend `PrinterDriver` (`drivers/base.js`), give
  the class a `static meta` (label, help and the setup form's fields), and add
  it to `DRIVERS` in `server.js`. The Settings form, secret handling and
  connection test then work without other changes. `drivers/moonraker.js` is a
  compact example, and `test/fake-printers.js` shows how to test against a
  fake API.

API (needs a session cookie from `POST /api/auth/login`): `GET /api/printers`, `GET /api/printers/:id/files`,
`POST /api/printers/:id/{pause|resume|cancel}`,
`POST /api/printers/:id/light {"on":true}`, `POST /api/printers/:id/print {"file":"x.gcode"}`.

## Tests and CI

- `npm test` runs the drivers against fake printer APIs (`test/fake-printers.js`)
  and the printer-setup API against a real hub process. It runs on every push
  ([tests](../.github/workflows/ci.yml)).
- Changes to `slicer/` are checked by
  [slicer-build](../.github/workflows/slicer-build.yml): it builds the slicer
  image, runs its self-test, and slices real STEP files for several printers.

## Releases

1. Bump `version` and `released` in `package.json` (the version shows in
   the app's top bar), and add the changes to [CHANGELOG.md](../CHANGELOG.md).
2. Push a tag such as `v0.11.0`.

The [release](../.github/workflows/release.yml) workflow runs the tests,
publishes `ghcr.io/shawman511/printer-hub` (amd64 + arm64) and
`printer-hub-slicer` (amd64), then runs `install.sh` on a clean machine
against the new images.
