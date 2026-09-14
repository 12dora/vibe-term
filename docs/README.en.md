<div align="right">
  <a href="../README.md">简体中文</a>
</div>

<div align="center">
  <img src="../apps/fe/public/logo.png" width="112" height="112" alt="VibeTerm" />
</div>

<h1 align="center">VibeTerm - The Remote Terminal Built for Vibe Coding</h1>

<p align="center">
  <a href="https://github.com/12dora/vibe-term/releases"><img src="https://img.shields.io/github/v/release/12dora/vibe-term?label=release" alt="Release" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-000" alt="Bun" />
</p>

<p align="center">
  An open-source, self-hosted web remote terminal: manage the terminals of every device from a phone, a tablet, or any browser.<br/>
  Run Claude Code, Codex, Grok, and other AI coding agents remotely from one place, keep them working in the background, and check results or send instructions from anywhere.
</p>

```bash
curl -fsSL https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | bash
```

<p align="center">
  <img src="./images/hero-en.png" width="880" alt="VibeTerm main view: a tmux terminal in the browser running Claude Code, with the device tree of several devices on the left" /><br/>
  <sub>Desktop: the cross-device device list on the left, Claude Code in the terminal on the right</sub>
</p>

VibeTerm links Macs, Linux servers, NAS boxes, and cloud VMs into one network. Every node only needs an internet connection, and NAT traversal works without a public IP. It is a better way to do remote development than SSH clients or cloud IDEs: the terminal always runs on the user's own device, so switching devices or closing the browser never interrupts a task.

## Features

<table width="100%">
  <tr><th width="33%">Multi-device mesh</th><th width="33%">Secure by design</th><th width="33%">Terminal sharing</th></tr>
  <tr><td valign="top">Sign in to any one device and operate all of them remotely.</td><td valign="top">End-to-end encrypted; a relaying server only ever sees ciphertext. Nodes do not trust each other, so a compromised node leaves the others safe.</td><td valign="top">Share a terminal by link the way you share a file, with password protection and recorded playback.</td></tr>
  <tr><th width="33%">Feels local</th><th width="33%">File transfer</th><th width="33%">AI Agent</th></tr>
  <tr><td valign="top">Scrolling and typing feel like a native terminal; swiping on the phone is silky smooth.</td><td valign="top">Move files freely between the browser and any node.</td><td valign="top">Let AI take over the terminal; no need to install an AI assistant on every device.</td></tr>
  <tr><th width="33%">Port mapping</th><th width="33%">Phone and tablet</th><th width="33%">Passkeys</th></tr>
  <tr><td valign="top">Map a remote port to the local machine and reach the remote service at localhost:&lt;port&gt;.</td><td valign="top">PWA support with a near-native experience.</td><td valign="top">Passkey / authenticator two-step verification for one more layer of security.</td></tr>
</table>

## Platforms

<table width="100%">
  <tr><th width="25%"><img width="250" height="0" align="left" />macOS</th><th width="25%"><img width="250" height="0" align="left" />Linux</th><th width="25%"><img width="250" height="0" align="left" />Windows</th><th width="25%"><img width="250" height="0" align="left" />iOS / Android</th></tr>
  <tr><td align="center">✅</td><td align="center">✅</td><td align="center">In development</td><td align="center">✅ via PWA</td></tr>
</table>

<table width="100%">
  <tr>
    <td width="33%" align="center" valign="top"><img width="330" height="0" align="left" /><img src="./images/mobile.png" width="240" alt="VibeTerm on a phone: remote tmux terminal" /><br/><sub>Terminal: the Claude Code UI with the shortcut bar at the bottom</sub></td>
    <td width="33%" align="center" valign="top"><img width="330" height="0" align="left" /><img src="./images/mobile-devices-en.png" width="240" alt="VibeTerm on a phone: device and window drawer" /><br/><sub>Devices: the window list of every node</sub></td>
    <td width="33%" align="center" valign="top"><img width="330" height="0" align="left" /><img src="./images/mobile-files-en.png" width="240" alt="VibeTerm on a phone: file panel" /><br/><sub>Files: browse, upload, and download remote files</sub></td>
  </tr>
</table>

## Deployment modes

<table width="100%">
  <tr><th width="50%">Standalone</th><th width="50%">Relay mode</th></tr>
  <tr><td valign="top">Install on one device and use it; binds to localhost by default.</td><td valign="top">Without any public address, route ciphertext through a self-run or third-party relay; one relay can serve many users. (The relay node is untrusted in this mode.)</td></tr>
</table>

<p align="center">
  <img src="./images/nodes-en.png" width="880" alt="VibeTerm node management: several devices in a mesh, with online state and connection path" /><br/>
  <sub>Settings → Mesh: HTTPS mode and node management, two devices online</sub>
</p>

## Deploying

### Deploy with an AI agent

Paste one of the prompts below into Claude Code, Codex, or a similar coding agent. It reads the [AI deployment guide](./operations/ai-deploy.md) and completes the deployment on the target device. Replace the angle-bracket placeholders with the actual values.

| Scenario | Prompt |
|---|---|
| Standalone | `Read https://raw.githubusercontent.com/12dora/vibe-term/main/docs/operations/ai-deploy.md and deploy VibeTerm on this device following the "独立部署" (Standalone) section.` |
| Create a relay · public domain | `Read https://raw.githubusercontent.com/12dora/vibe-term/main/docs/operations/ai-deploy.md and set up a relay following the "中继：公网域名" (Relay: public domain) section. The domain is <domain>; ports 80/443 are <available/unavailable>.` |
| Create a relay · no public IP, router port forwarding | `Read https://raw.githubusercontent.com/12dora/vibe-term/main/docs/operations/ai-deploy.md and set up a relay following the "中继：端口转发" (Relay: port forwarding) section. The router forwards public port <port> to this device; the public address is <IP or DDNS domain>.` |
| Create a relay · no public IP, Cloudflare Tunnel | `Read https://raw.githubusercontent.com/12dora/vibe-term/main/docs/operations/ai-deploy.md and set up a relay following the "中继：Cloudflare Tunnel" (Relay: Cloudflare Tunnel) section. The tunnel hostname is <domain>.` |
| Join a relay | `Read https://raw.githubusercontent.com/12dora/vibe-term/main/docs/operations/ai-deploy.md and connect this device to the relay following the "加入中继" (Join a relay) section. The relay address is <address>; the tenant ID is <id>.` |

### Deploy by hand

After the one-line install, run `vibeterm --help` for every subcommand; `vibeterm doctor` checks the environment and `vibeterm upgrade` updates. The full manuals are the [installation guide](./operations/production-install.md) and [mesh operations](./operations/mesh-operations.md) (Chinese).

## Command line

Every install ships the `vibeterm` client commands, which do from a terminal what the web UI does: attach to a terminal pane on any node the way ssh would, move files, map ports, and manage nodes and site settings. They reach the entry over plain HTTP / WebSocket, so they also run on a machine with no VibeTerm service installed — and an AI coding agent running on one machine can use them to debug every other device in the mesh.

```bash
vibeterm login --entry https://vt.example.com --user admin      # one login covers every node behind the entry
vibeterm nodes ls                                               # nodes and their online state
vibeterm term attach konata-mac/dev                             # attach to a device's terminal pane
vibeterm term run konata-mac/dev "make test" --marker --json    # run one command, get output and exit code
vibeterm term capture konata-mac/dev --strip-ansi               # grab the current screen
vibeterm cp ./dist air:home/dist -r                             # copy files between this machine and a node
vibeterm port map 8080 air:127.0.0.1:8080                       # expose a remote port at localhost:8080
vibeterm api GET /api/mesh/nodes --json                         # call any endpoint that has no command wrapper
vibeterm logout                                                 # revoke the sessions
```

**The security boundary is exactly the web UI's.** The CLI has no local privilege: it holds the same session cookies a browser would, and reaching another node goes through the entry's `/n/<node>/` forwarding carrying that node's own session — never the local mesh identity or master key. Sessions are revocable at any time; `vibeterm logout` is the same as signing out in the browser. With two-step verification enabled, one valid TOTP code is enough (a passkey satisfies it too, but only in a browser). For non-interactive use put the password in `VIBETERM_PASSWORD` and the code in `VIBETERM_TOTP` rather than on the command line.

The full manual is the [CLI usage guide](./operations/cli-usage.md) (Chinese).

## Acknowledgements

VibeTerm is a derivative of [krhougs/tmex](https://github.com/krhougs/tmex). Without the original author's groundwork this project would not exist.

## Documentation

Architecture, operations, security, and development docs live in [docs/](./README.md) (Chinese).

## License

[MIT](../LICENSE)
