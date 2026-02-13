# Troubleshooting

## FailedToOpenSocket with ANTHROPIC_BASE_URL on macOS

**Symptom:** Claude Code CLI fails with `API Error: Unable to connect to API (FailedToOpenSocket)` when spawned from the OpenClaw gateway running as a macOS launchd agent, with `ANTHROPIC_BASE_URL` pointing to a LAN address (e.g., `http://192.168.x.x:port`).

Without `ANTHROPIC_BASE_URL` (connecting to `api.anthropic.com`), the CLI starts normally.

**Root cause:** macOS Sequoia (15.x+) **Local Network Privacy** restricts LAN access for processes running under launchd agents. Internet connections are always allowed, but connections to private IP ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x) require explicit user permission.

When running from Terminal, processes are exempt because Terminal.app is a system app. When running as a launchd agent, third-party binaries (`node`, `claude`) are subject to Local Network Privacy, and macOS has known bugs where the permission prompt is never shown for background processes (Apple FB16131937).

**Diagnosis:**

| Launch method | LAN relay URL | Internet URL | Result |
|---|---|---|---|
| Terminal (foreground) | works | works | Terminal is exempt |
| `npm run debug` (from Terminal) | works | works | Inherits Terminal's exemption |
| launchd agent (background) | **FailedToOpenSocket** | works | LAN blocked by Local Network Privacy |

**Fixes (pick one):**

1. **Grant Local Network access in System Settings:**
   - System Settings → Privacy & Security → Local Network
   - Find `node` (or the relevant binary) and toggle it on
   - If `node` is not listed, this is a known macOS bug — try fix #2 or #3

2. **Use a remote/internet relay endpoint** instead of a LAN IP address. Route through a public endpoint or tunnel (e.g., Cloudflare Tunnel, ngrok) so the connection is not classified as "local network."

3. **Run the gateway in the foreground** (from a terminal session) instead of as a launchd agent.

4. **Switch to a LaunchDaemon** (runs as root, exempt from Local Network Privacy). Note: this changes the security model of the gateway process.

**References:**
- [Sequoia 'local network' permission failure from launch agent](https://developer.apple.com/forums/thread/778457)
- [Local Network permission prompt for daemon on macOS 15](https://developer.apple.com/forums/thread/763753)
- [Local Network Privacy on Sequoia](https://mjtsai.com/blog/2024/10/02/local-network-privacy-on-sequoia/)
- [Claude Code native binary proxy issue #14165](https://github.com/anthropics/claude-code/issues/14165)
