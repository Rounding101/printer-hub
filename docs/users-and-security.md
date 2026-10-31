# Users and security

[← Back to the README](../README.md)

The hub controls real printers, so every page and API call needs a signed-in
user. Only the sign-in page and `/api/health` are open.

- **First run:** the hub prints a one-time **setup code** in its log
  (`*** First run: ... setup code XXXXX-XXXXX`; with Docker,
  `docker compose logs printer-hub`). Open the hub, enter the code, and create
  the admin account. After that, the code is gone.
- **Settings → Users** (admins only) adds accounts with one of three roles:
  - **Admin**: everything, including printers and users.
  - **Operator**: print, control printers, manage files, rolls and the job log.
  - **Viewer**: watch status, cameras and logs. Every change is refused.
- **Account** (your name, top right): change your password, see the devices
  you're signed in on, and sign them out.
- Sessions last 30 days and renew as you use them. Untick *Keep me signed in*
  for a session that ends when the browser closes, or after 12 hours.
- Changing or resetting a password signs that user out everywhere else.
  Deleting a user ends their sessions and live view at once.
- Eight wrong passwords lock that username and that address out for 15 minutes.
- **Forgot the admin password:** set the environment variable
  `HUB_RESET_PASSWORD=<username>` on the hub container and restart it. The log shows a new random password. Sign in, change
  it, then remove the variable.

Passwords are stored as scrypt hashes and sessions as SHA-256 hashes of their
tokens, in `data/auth.json`. The session cookie is HttpOnly and SameSite=Lax,
and changes from other sites are refused (Origin check). If you put the hub
behind an HTTPS reverse proxy, the cookie gets the Secure flag from
`X-Forwarded-Proto`. Set `TRUST_PROXY=true` on the hub container so failed
sign-ins are counted per real client address (see [Installation](installation.md#https-and-remote-access)).

## Keep it on your network

Even with sign-in, keep the hub on your home network or reach it over a VPN
(WireGuard, Tailscale, …). Don't port-forward it to the internet: it can heat
and move your printers.

To report a security problem, see [SECURITY.md](../SECURITY.md).
