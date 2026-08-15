# Remote access with Tailscale

Pi Dash can expose its desktop-owned daemon to explicitly allowed Tailscale users. Remote access is private to the tailnet, remains available only while Pi Dash Desktop is running, and never changes the daemon's numeric-loopback bind.

Pi Dash does not install, configure, or manage Tailscale. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) terminates HTTPS/WSS and proxies to the loopback daemon. **Do not enable Tailscale Funnel for Pi Dash.**

## Trust model

Remote access has two independent checks:

1. Tailnet grants decide which users can reach TCP 443 on the Pi Dash host.
2. Pi Dash requires `Tailscale-User-Login` on every remote page, API request, and WebSocket upgrade and compares it with its exact configured allowlist.

Serve removes client-supplied identity headers before injecting its authenticated values. Pi Dash does not trust `X-Forwarded-*`, the proxy source address, public Host/Origin alone, or a session cookie alone. The daemon continues to accept local Electron sessions independently.

The remote UI can create worktrees, mutate Git repositories, launch Pi, and open an arbitrary-command shell as the desktop user. Every allowed identity and every device logged into those accounts must therefore be trusted with that Unix account's Pi Dash capabilities and workspace secrets.

## Prerequisites

- Tailscale is connected on the Pi Dash host and every remote computer.
- MagicDNS and HTTPS certificates are enabled for the tailnet.
- The host has a stable, nonsensitive device name. Its full `*.ts.net` certificate name is published in Certificate Transparency logs.
- Funnel is disabled.

Find the host origin and the local user's exact login name:

```sh
tailscale status --json | python3 -c '
import json, sys
status = json.load(sys.stdin)
self = status["Self"]
user = status["User"][str(self["UserID"])]
print("origin=https://" + self["DNSName"].rstrip("."))
print("login=" + user["LoginName"])
'
```

Other allowed users must provide the exact login identity shown by Tailscale. Shared external users are supported only when their exact external identity is listed. Tagged source devices do not have a human `Tailscale-User-Login` and cannot authenticate to Pi Dash.

## Configure Pi Dash

Edit `$XDG_CONFIG_HOME/pi-dash/config.json`, falling back to `~/.config/pi-dash/config.json`:

```json
{
  "remoteAccess": {
    "provider": "tailscale",
    "origin": "https://nixos.example-tailnet.ts.net",
    "allowedUsers": ["user@example.com"]
  }
}
```

The origin must be the exact root HTTPS `*.ts.net` URL on port 443. Login comparison is exact and case-sensitive. Remote configuration is rejected by standalone daemon launches; start Pi Dash through the desktop application.

Equivalent desktop command-line options are repeatable for users:

```sh
pi-dash \
  --tailscale-origin https://nixos.example-tailnet.ts.net \
  --tailscale-user user@example.com
```

Environment configuration uses `PI_DASH_TAILSCALE_ORIGIN` and a JSON string array in `PI_DASH_TAILSCALE_USERS`.

## Restrict tailnet access

Use a narrow Tailscale grant permitting only intended users to reach TCP 443 on the Pi Dash host. For example, when the host owns `tag:pi-dash-host`:

```json
{
  "groups": {
    "group:pi-dash-users": ["user@example.com"]
  },
  "grants": [
    {
      "src": ["group:pi-dash-users"],
      "dst": ["tag:pi-dash-host"],
      "ip": ["tcp:443"]
    }
  ]
}
```

Tailscale grants are additive. Audit existing broad grants or ACLs because a narrower rule does not override broader access. The Pi Dash identity allowlist remains a separate defense.

## Start Serve

Pi Dash uses port 4317 unless configured otherwise. Start the desktop application, then configure the persistent Serve proxy:

```sh
tailscale serve --bg http://127.0.0.1:4317
tailscale serve status
```

Open the configured HTTPS origin from another tailnet computer. Serve persists independently, but it returns an upstream error whenever Pi Dash Desktop is not running. Closing the final Pi Dash window terminates the daemon, its terminal processes, sessions, and remote connections.

Inspect or remove Serve configuration with:

```sh
tailscale serve status --json
tailscale serve --https=443 off
tailscale serve reset
```

Never substitute `tailscale funnel` for these commands.

## Remote behavior

- Remote sessions last at most 12 hours and renew through the current Tailscale identity.
- Cookies are `HttpOnly`, `Secure`, and `SameSite=Strict`; mutations retain CSRF checks.
- Terminal and application-event WebSockets require the same identity on upgrade and close when the session expires.
- The first attached terminal client owns input. A second local or remote client may be read-only until the owner disconnects; input takeover is not part of the initial remote feature.
- Native host directory dialogs are unavailable remotely. Enter paths from the host filesystem instead.
- Electron continues to use its local loopback session and native directory dialog.

## Revocation and troubleshooting

For immediate application-level revocation, close Pi Dash Desktop. Then remove the identity from `allowedUsers`, remove its TCP 443 tailnet grant, or disable Serve before restarting Pi Dash. Pi Dash does not claim that a grant edit terminates an already established socket; closing the application always does.

If authentication fails:

1. Confirm `tailscale serve status` shows an HTTPS proxy—not Funnel—to the configured loopback port.
2. Confirm the browser URL exactly matches `remoteAccess.origin`.
3. Confirm the current `Tailscale-User-Login` exactly matches one configured value.
4. Confirm the source is a human-owned Tailscale node rather than a tagged node.
5. Close and reopen Pi Dash after changing configuration.

The initial compatibility probe was verified with Tailscale 1.102.2: Serve preserved the public Host and browser Origin, injected identity on HTTP and WebSocket upgrades, stripped spoofed duplicate identity headers, and proxied long-lived WSS connections. Future release smoke tests must repeat HTTP, WSS, spoof stripping, reconnect, and Funnel-disabled checks against the supported Tailscale version.
