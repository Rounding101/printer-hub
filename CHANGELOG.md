# Changelog

What changed in each version. The running version is shown under the name in
the app's top bar.

## 0.16.0 — 2026-11-01

### Changed
- **Job log and Totals are one page.** The job log has two tabs, **All prints**
  and **By item**, with the same filters and tiles. By item now shows which
  printers made each item, and clicking an item shows its prints.
- **New logo**, in the top bar, the browser tab and the sign-in page.

### Install
- **[AGENTS.md](AGENTS.md):** exact steps for an AI coding agent to deploy the
  hub and add printers, including what it must ask first.
- New **build from source** route in the installation guide.
- The published compose file names its volume `printer-hub-data`, so the backup
  and uninstall commands work whatever folder it's in.
- The setup code command shows only the newest code; a Windows version is added.
- Backup commands work on every install route, and restoring is now spelled out.
- A new `deploy-check` workflow runs the documented routes on clean machines.

## 0.15.1 — 2026-11-01

### Fixed
- **Finished prints logged as failed or cancelled.** If a printer reported an
  error or idle for a moment mid-print and then carried on, the job log closed
  the job and started a second one. It now reopens the same job when the
  printer resumes the same file at the same progress (within 30 minutes).
- Printers that report whole percents and go idle at 99% count as finished.
- A blip like that no longer ends a timelapse recording either.

### Added
- The job log shows **why** a print ended without finishing, e.g. "Printer
  reported an error (at 43%)", and writes it to the hub's log.

## 0.15.0 — 2026-10-31

### Added
- **Timelapses.** The hub records every print on printers with a camera: a
  frame per layer, turned into a short MP4 when the print ends, cropped like
  the camera. A new **Timelapses** page plays, downloads and deletes them, and
  a **● REC** badge shows while recording. On by default; turn it off per
  printer in Settings.
- Timelapses made by Klipper (moonraker-timelapse) and OctoPrint printers are
  listed on the same page and streamed through the hub.
- The Docker image now includes FFmpeg.

## 0.14.0 — 2026-10-31

### Added
- **Camera crop.** Admins can crop each printer's camera to the part that
  matters, such as the build plate: hover over the camera in the control
  panel, click **Crop**, drag a box and save. Every card and view shows the
  crop; **Full frame** removes it. Saving a crop doesn't reconnect the
  printer.

## 0.13.0 — 2026-10-31

### Added
- **Clear** button for printers that show a finished print: marks the plate
  as clear and the printer ready. On the Adventurer 5M it also dismisses the
  printer's own "clear the platform" prompt; Klipper printers get
  `SDCARD_RESET_FILE`. The job log keeps the finished print.

## 0.12.0 — 2026-10-31

### Added
- **Print previews on the printer's screen.** Files the hub slices now include
  preview images in the sizes and formats each printer's profile asks for
  (e.g. 140×110 on the Adventurer 5M, 230×110 on the Kobra X, QOI images on
  Prusa printers, 32×32 and 300×300 for Klipper). They're drawn from the
  sliced toolpaths, so they show exactly what will print: every copy on the
  plate, as arranged.
- Previews in the hub: next to each file in the library, and next to the job
  on printer cards and the control panel. Files sliced elsewhere show their
  own embedded previews.

### Fixed
- Library and totals tables: the action buttons' column no longer breaks the
  row lines.

## 0.11.0 — 2026-10-31

The first public release.

### Added
- **Any printer, set up in the browser.** Admins add, edit, test and remove
  printers under **Settings → Printers**. Each type shows its own fields, and
  **Test connection** says exactly what's wrong (wrong key, unreachable, …).
- **New printer types:** Klipper (Moonraker), OctoPrint and Prusa (PrusaLink).
- **Slice for any printer:** pick one of OrcaSlicer's ~1,000 printer profiles
  (64 brands), or a generic Klipper/Marlin profile.
- **One-line installer** (`install.sh`) and a ready-to-use
  `deploy/docker-compose.yml` with published images
  (`ghcr.io/shawman511/printer-hub`, `printer-hub-slicer`). The hub image also
  runs on ARM (Raspberry Pi), without slicing.
- `TRUST_PROXY` environment variable for running behind a reverse proxy.
- Documentation in `docs/`, issue forms, and automated tests (drivers against
  simulated printers, the setup API) on every push.

### Changed
- **Users** moved into **Settings**, next to **Printers**.
- Brands without filament profiles of their own (Voron, Custom, …) use
  OrcaSlicer's shared filament library instead of an empty list.
- Printers without a default build plate get the plate the filament has
  temperatures for, so the bed heats properly (e.g. 60 °C instead of 45 °C on
  a Prusa MK4).

### Fixed
- Removing or editing a printer while it was being polled left a background
  connection running.

### Upgrading from 0.10
Printers configured through `AD5M_HOST` / `KOBRAX_HOST` environment variables
are imported into Settings on the first start, keeping their job history and
filament rolls. After that the variables can be removed.

## 0.10.0 — 2026-10-31

### Added
- Printers getting ready to print (file check, leveling, heating) show
  **Preparing *file*** with the stage and the estimated print time, instead of
  looking idle.
- The light is an on/off **switch** that shows the light's actual state.
- MIT license, security policy, screenshots and a public README.

## 0.9.x — 2026-10-31

### Added
- **STEP files** can be sliced: they're converted to a mesh with OpenCASCADE
  first, since OrcaSlicer's command-line slicer can't read STEP.
- The running **version** is shown in the top bar.

## Before 0.9

Dashboard and cameras for FlashForge Adventurer 5M and Anycubic Kobra X,
control panel, file library, OrcaSlicer slicing with 3D preview, job log and
totals, filament roll tracking, blocking files sliced for another printer,
and sign-in with admin, operator and viewer accounts.
