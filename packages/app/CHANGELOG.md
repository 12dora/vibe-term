# 2.0.1

_2026-09-07_

## English

### Fixes

- **Sign-in after changing the access address.** The passkey second factor is now decided per address: an address that has no passkey no longer blocks password sign-in (two-step verification, if enabled, still applies; the event is audited). The skip is granted only to addresses the server itself knows — the site URL, the Cloudflare Tunnel hostname, the Hub public address or the relay entry — so a forged `Origin` header cannot bypass the check. The sign-in page hints to add a passkey for the new address, and `vibeterm mesh passkey remove-all` is available as an escape hatch (`vibeterm doctor` points to it).
- **Relay password rotation with "keep existing tenants".** Re-enrolling the primary node after a keep-rotation no longer reissues the tenant token, so member nodes stay connected. When a token is reissued, the previous token remains valid for 30 days (re-checked on heartbeat and on every new stream) and members switch over on their own; "kick" still voids everything immediately. Members that were already cut off recover with `vibeterm relay resend-token` on the primary, or by re-joining with the account password on the member (same account only; it catches up the key log first, including a missed root rotation).
- **Connect Devices → mobile address list.** The Hub entry appears only when this machine is the Hub; fake-IP (198.18/15), container, VM and link-local addresses are dropped; Tailscale and VPN addresses are labelled as such and ranked after the physical LAN; bridges that carry the LAN address are kept; the relay entry is listed once probed.
- **Rates and live byte counters no longer change width.** Rates always show one decimal from KB/s upwards, counters that refresh live use the same fixed format, and every reading reserves its full width. Direction arrows carry screen-reader labels.
- **Loading states after joining a relay.** Multi-node, Manage Devices, node pickers, share sources and the notification card show a syncing state until the member list has been applied, instead of an empty or "this machine only" view. Device cards load as dashed placeholder cards that fade into the real cards.
- **Leave relay dialog.** The credential prompt is now a nested dialog: it is no longer hidden behind the confirmation dialog and is keyboard-accessible inside side panels (Esc cancels).
- **CLI shims.** Shim directories must be passed explicitly and a managed shim owned by another existing install is never overwritten; the CLI unit tests run under a sandboxed HOME so they can no longer touch `~/.local/bin` or `~/.bun/bin`.

### Changed

- **Settings → General → About** replaces "Version & updates": version, install source, service manager, run mode, copyright, license (MIT), project page and the tmex acknowledgement; "Check for updates" moved to the title row. A `LICENSE` file is now shipped.
- **Settings → Devices & files** is removed. Directory roots are configured from Manage Devices → device card → ⋯ → Files; the Files sidebar shows a one-line hint with a link when nothing is configured.

---

## 中文

### 修复

- **切换访问地址后无法登录。** 通行密钥二次验证改为按地址判定：没有通行密钥的地址不再阻止密码登录（已启用的两步验证仍然生效，并记录审计）。放行仅限服务端自身识别的入口——站点 URL、Cloudflare Tunnel 域名、Hub 公网地址、中继入口——伪造 `Origin` 头无法绕过。登录页提示为新地址添加通行密钥；`vibeterm mesh passkey remove-all` 作为逃生命令（`vibeterm doctor` 会提示）。
- **中继改密「保留现有租户」。** 改密后主节点重新接入不再换发租户令牌，成员节点不再掉线。换发令牌时旧令牌保留 30 天宽限（心跳与新建流时复查），成员自行切换；「作废旧令牌」仍立即生效。已被断开的成员可在主节点执行 `vibeterm relay resend-token`，或在成员上用账户密码重新加入（仅限同一账户；会先追平密钥日志，漏掉的根轮换也能补上）。
- **接入设备 → 移动设备地址列表。** Hub 仅在本机为 Hub 时出现；丢弃 fake-IP（198.18/15）、容器、虚拟机与链路本地地址；Tailscale 与 VPN 地址单独标注并排在物理局域网之后；承载局域网地址的网桥保留；中继入口探通后列出。
- **速率与实时流量不再抖动列宽。** 速率固定一位小数并从 KB/s 起档，实时刷新的流量计数使用同一格式，每个读数预留完整宽度；方向符号补读屏文本。
- **加入中继后的加载态。** 多节点互联、管理设备、节点选择器、分享来源与通知卡在成员列表应用前显示同步中，不再显示为空或「仅本机」；设备卡片以虚线占位卡片加载并淡入切换。
- **离开中继对话框。** 凭据弹层改为嵌套对话框：不再被确认框遮挡，侧滑面板内可用键盘操作（Esc 取消）。
- **CLI shim。** shim 目录必须显式指定，属于其他仍存在安装的托管 shim 不会被覆盖；CLI 单测在沙箱 HOME 下运行，不再可能触碰 `~/.local/bin` 与 `~/.bun/bin`。

### 变更

- **设置 → 通用 → 关于** 取代「版本与更新」：版本、安装方式、服务、运行模式、版权、许可证（MIT）、项目地址与 tmex 致谢；「检查更新」移至标题行。随包附带 `LICENSE`。
- **设置 → 设备与文件** 已移除。目录在「管理设备 → 设备卡片 → ⋯ → 文件」配置；文件侧栏未配置时显示一行带链接的提示。
