# Security

Printer Hub can start prints and drive heaters and motors, so security
problems matter even on a home network.

## Reporting a problem

Please report vulnerabilities privately with GitHub's
**Report a vulnerability** button on this repository's **Security** tab,
not in a public issue. Include what an attacker could do, the steps to
reproduce it, and the version from the hub's top bar.

## What's in scope

- Getting past sign-in, or doing more than your role allows
- Running commands or reading files on the hub or slicer containers
- Making the hub send something to a printer that the user didn't ask for

The printers' own local APIs (FlashForge and Anycubic LAN mode) are outside
this project; report problems with those to their makers.

## Running it safely

- Keep the hub on your home network or behind a VPN. Don't port-forward it.
- Use a strong admin password, and give people who only need to watch a
  **Viewer** account.
- Keep printer credentials (the AD5M check code) in environment variables or
  `config.json`, which is git-ignored, never in the repository.
