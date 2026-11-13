# 2.15.0

_2026-11-14_

## English

### Security hardening

This release tightens security across the web UI, node-to-node links, relays, access tokens and installation. Upgrade relays and nodes together: nodes still on 2.14 cannot recover a relay password join against an upgraded relay until they are upgraded too.

### What changes for you

- **Password change signs out everywhere.** Changing your account password now signs out all devices and revokes access tokens, terminal shares and pane grants. The browser and CLI you changed it from sign back in automatically; create new access tokens afterwards. Passkeys and two-step verification are kept.
- **New account passwords need at least 12 characters** and must not be an obvious sequence, repeat or common password. Existing passwords keep working.
- **Adding a device needs your confirmation.** The new device shows a confirmation code (`vibeterm relay join` prints it); confirm on the Nodes page only if it matches. Devices are no longer added automatically.
- **Join command:** the copied command now passes the join code through `VIBETERM_RELAY_JOIN_TOKEN` (or `--token-stdin`) instead of the command line.
- **Removing a node** also revokes the access tokens, terminal shares, pane grants and port maps created through it, and the relay credentials are renewed.
- **Access tokens with the `files` scope** only work in file roots you configured; the automatic home folder is not available to tokens, and VibeTerm's own data, SSH keys and shell startup files are always refused. Revoking a token removes the port maps it created.
- **Port maps** can no longer forward to the node's own VibeTerm ports or cloud metadata addresses.
- **Browser:** requests and terminal connections from other websites are refused. Files such as SVG, HTML and XML open as downloads instead of in the page.
- **Reverse proxies:** set `VIBETERM_CLIENT_IP_HEADER` to the header your proxy sets (`x-forwarded-for` by default, `cf-connecting-ip` for Cloudflare Tunnel, which is set automatically). Forwarded headers are only trusted from a proxy on the same host or LAN.
- **Upgrades:** remote upgrades never install an older version; locally use `vibeterm upgrade --version <v> --allow-downgrade`.
- **Relays** accept at most 50 tenants by default (`VIBETERM_RELAY_MAX_TENANTS`) and limit password checks to protect the relay under load.
- Installation folders and the database are now readable only by the VibeTerm user.

---

## 中文

### 安全加固

本版本在网页、节点间连接、中继、访问令牌与安装等方面全面加强安全性。请将中继与节点一起升级：仍是 2.14 的节点在中继升级后，需先升级才能通过中继密码重新加入。

### 使用上的变化

- **修改密码会退出所有设备**：修改账号密码后，所有设备需重新登录，访问令牌、终端分享与窗格授权一并撤销。发起修改的浏览器与 CLI 会自动重新登录；访问令牌需重新创建。通行密钥与两步验证保留。
- **新设置的账号密码至少 12 位**，且不能是明显的连续、重复字符或常见密码；已有密码不受影响。
- **添加设备需要人工确认**：新设备会显示确认码（`vibeterm relay join` 会打印），在「节点」页核对一致后再确认；不再自动加入。
- **加入命令**：复制的命令改为通过 `VIBETERM_RELAY_JOIN_TOKEN`（或 `--token-stdin`）传入加入码，不再写在命令行参数里。
- **移除节点**时，经该节点创建的访问令牌、终端分享、窗格授权与端口映射一并撤销，中继凭据随之换发。
- **`files` 权限的访问令牌**只能使用已配置的文件根，自动的主目录根对令牌不可用；VibeTerm 自身数据、SSH 密钥与 shell 启动文件一律拒绝。撤销令牌会同时删除它创建的端口映射。
- **端口映射**不能再指向本节点自身的 VibeTerm 端口或云厂商元数据地址。
- **浏览器**：来自其它网站的请求与终端连接一律拒绝；SVG、HTML、XML 等文件改为下载，不在页面中打开。
- **反向代理**：通过 `VIBETERM_CLIENT_IP_HEADER` 指定代理设置的头（默认 `x-forwarded-for`，Cloudflare Tunnel 为 `cf-connecting-ip`，开启隧道时自动设置）；只信任同机或局域网内代理转发的头。
- **升级**：远程升级不会安装更旧的版本；本机降级需 `vibeterm upgrade --version <v> --allow-downgrade`。
- **中继**默认最多 50 个租户（`VIBETERM_RELAY_MAX_TENANTS`），并限制密码校验频率，避免中继在高负载下失去响应。
- 安装目录与数据库改为仅 VibeTerm 运行用户可读。
