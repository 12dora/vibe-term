<div align="right">
  <a href="./README.zh-CN.md">简体中文</a>
</div>

<div align="center">
  <img src="apps/fe/public/logo.png" width="128" height="128" alt="tmex" />
</div>

<h1 align="center">tmex</h1>

<p align="center">
  A terminal workspace for tmux, rebuilt for the agent era.<br/>
  Run agents, watch panes, and manage remote machines from any device.
</p>

<p align="center">
  <img src="docs/images/screenshot.png" width="640" alt="tmex screenshot" />
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#highlights">Highlights</a> ·
  <a href="#install--upgrade">Install & Upgrade</a> ·
  <a href="#security">Security</a> ·
  <a href="#faq">FAQ</a>
</p>

---

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/12dora/tmex-enhanced/main/install.sh | bash
```

The installer generates keys, deploys runtime files, registers a user service (launchd on macOS, systemd on Linux), and starts tmex. Open the URL it prints, add your devices, and you are done.

## Highlights

| **Open source, with history preserved** | **One-command install, self-updating** | **One sidebar for panes, agents, and files** |
|---|---|---|
| tmex is built in public with AI agents. Every design decision, iteration, and dead end is archived in `prompt-archives/` and `docs/`, so the engineering process is inspectable and reproducible. | The one-line install script installs the service, generates keys, and starts serving. Upgrade in one click from the settings page, or run `tmex upgrade`. Rollback is automatic if anything fails. | The left sidebar unites the device tree, AI Agent, and file manager. The Agent is tied to the active tmux pane: switch panes and the Agent context switches with you. |

| **Agent for coding and ops** | **Watch: a sentry for long jobs** | **Access your terminals from anywhere** |
|---|---|---|
| The server-side AI Agent reads the screen, runs commands, sends keystrokes to interactive programs, searches the web, and fetches pages. Use it for coding, log inspection, service restarts, network gear config, or any step-by-step maintenance task. | Watch monitors any pane on a schedule. Catch a download stuck at 73%, a build that errors out, or a log line that should not appear. Alerts go out through Telegram, webhook, or browser push. | tmex works on laptop, tablet, and phone. Install it as a standalone app and pick up where you left off. Mobile input is deliberately polished: the on-screen keyboard does not break your terminal layout, and editor mode lets you compose long commands comfortably. |

| **Ghostty WASM terminal** | **Local and SSH devices** | **Native tmux Control Mode** |
|---|---|---|
| The browser-side terminal uses Ghostty’s official VT kernel compiled to WebAssembly. You get native-grade terminal semantics without a hand-rolled ANSI parser. | Manage local machines and remote SSH hosts side by side. Authenticate with password, private key, SSH Agent, or SSH Config. Drag to reorder the device tree. | tmex is built on tmux Control Mode, so pane output, window lifecycle events, and bell notifications arrive in real time. Use the web UI alongside iTerm2 or any native tmux client. |

**Multi-machine mesh.** Any tmex install can join a mesh: one machine with a public HTTPS address acts as the hub, and the rest join it with a join code, needing only outbound connections. Every node is a full entry point — open any one of them and you see and operate every machine in the mesh. Nodes connect to each other directly over WebRTC where possible and fall back to hub relay, and every link is encrypted end to end. Set it up in **Settings → Multi-node Mesh**, or from the CLI with `tmex init --role hub,node` and `tmex hub join <https-url> --token <t>`.

## Install & Upgrade

```bash
# Interactive install (recommended)
curl -fsSL https://raw.githubusercontent.com/12dora/tmex-enhanced/main/install.sh | bash

# Silent install for CI or automation
bash install.sh --no-interactive \
  --install-dir ~/.local/share/tmex \
  --host 127.0.0.1 \
  --port 9883 \
  --db-path ~/.local/share/tmex/data/tmex.db \
  --autostart true

# Environment diagnosis
tmex doctor

# Upgrade to the latest version
tmex upgrade

# Uninstall
tmex uninstall
```

Installation requires [Bun](https://bun.sh) (the installer will install it if missing). The `doctor` command will check your environment and report any issues. If `tmex` is not found after install, add `~/.local/bin` to PATH.

## Security

tmex ships a full authentication stack, but on a standalone install it is **off by default**: a fresh install binds to `127.0.0.1:9883` and serves no login page. Turn on login protection in **Settings → Remote access** before the UI is reachable from anywhere but the machine itself. A machine that joins a mesh always requires login — there the switch does not exist.

**Accounts.** The password never leaves the browser. Argon2id (64 MiB, 3 passes) derives an Ed25519 root key client-side; the server stores only the root public key and the KDF parameters. A login signs a delegation valid for 18 hours to a per-browser session key, and node sessions renew on a sliding 18-hour window with a 7-day hard cap. Failed logins are rate limited per source IP and per account, and every credential failure returns the same error.

**Second factors, both optional.** Register a passkey (WebAuthn) and password logins additionally require a passkey assertion; a passkey can also be used to sign in on its own. Requests whose source address is loopback, private, link-local, or CGNAT skip that step — WebAuthn cannot be used on IP-literal origins such as `http://192.168.1.5:9883`. TOTP is independent and can be enabled alongside it; its secret is encrypted under a key derived from the root key and decrypted only during login.

**Credential rotation.** Passkeys, TOTP, node certificates, and hub authorizations live in a hash-chained log signed by the root key and replicated to every node. A normal password change rotates the root key and keeps passkeys, TOTP, and open sessions; `tmex hub user passwd <user> --full-reset` also removes every passkey and TOTP and signs out everywhere.

**Mesh.** Membership is proved by Ed25519 node certificates issued by your root key — the hub issues no credentials of its own. Node-to-node links are mutually authenticated and encrypted end to end with AES-256-GCM, so a relaying hub only ever moves ciphertext.

**Transport.** The built-in TLS listener serves a self-signed CA or a Let's Encrypt certificate obtained over ACME (`http-01`, or `dns-01` via Cloudflare or DNSPod). You can also terminate TLS at your own reverse proxy and set `TMEX_TRUST_PROXY=true` so tmex reads the real client address and scheme. Without a public IP, tmex downloads and supervises `cloudflared` itself — on your own hostname or as a quick tunnel — and can enforce [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/) JWTs in front of it.

- Passwords and private keys are encrypted at rest with AES-256-GCM.
- Webhook notifications are signed with HMAC-SHA256.
- Agent terminal writes are bound to a single pane and require explicit approval by default.
- `fetch_url` denies loopback, link-local, and private addresses by default to prevent SSRF.
- Every node has an "Allow Domain Access" switch: turn it off and only local and private-network clients reach it, while mesh traffic keeps flowing.

**Still on you.** Pick a strong password, serve tmex over HTTPS (passkeys and `Secure` cookies need it), and keep every node upgraded — during a rolling upgrade a node on an older version still accepts password-only logins.

## FAQ

**Q: How do notifications work with coding agents?**

tmex listens for both BEL (`\a`) and common OSC notification sequences such as OSC 9, OSC 99, OSC 777 `notify`, and iTerm2 OSC 1337 `RequestAttention`. Claude Code, Codex, and OpenCode already emit one of these, so notifications usually work out of the box. You only need to add an explicit `\a` instruction if your agent does not.

**Q: How do Telegram notifications work?**

Add one or more Telegram bots in Settings, then approve the chats that are allowed to receive alerts. tmex sends notifications for bell events, Agent confirmation requests, Watch triggers, and errors. Each bot can serve multiple chats, and you can revoke access at any time.

**Q: Does an SSH host with many panes exhaust `MaxSessions`?**

No. tmex used to open one remote reader channel per pane; it now multiplexes every pane of a device over a **single shared tmux control-mode channel**, plus a long-lived command channel and short-lived channels for one-off commands and file transfers. Channel usage no longer grows with pane count, so OpenSSH's default `MaxSessions` of 10 is normally enough. Raise it only if you also run rsync transfers and your own SSH sessions against the same host at the same time.

**Q: Why is OSC passthrough disabled by default?**

Disabled passthrough prevents pane processes from forwarding private terminal control sequences to the host terminal, reducing the terminal-escape attack surface. If you need host terminals such as iTerm2 to receive OSC sequences, set `TMEX_TMUX_ALLOW_PASSTHROUGH=true`.

## License

MIT
