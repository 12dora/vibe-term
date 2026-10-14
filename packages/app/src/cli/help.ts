import type { CliLang } from '../i18n';

/** `--stun-servers` 的帮助说明：默认随发行版内置列表，`none` 禁用。 */
export const STUN_SERVERS_FLAG_HELP =
  'default: built-in list shipped with each release; `none` disables';

const HELP_EN = `VibeTerm CLI (tmex remains available as an alias)

Usage:
  vibeterm init [--role standalone|node|relay|relay,node] [--install-dir <path>] [--host <host>] [--port <port>] [--db-path <path>] [--autostart <true|false>] [--service-name <name>] [--no-interactive] [--bun-path <path>] [--install-deps] [--skip-dep-check] [--force] [--relay-public-url <url>] [--public-port <port>] [--peer-port <port>] [--stun-servers <list>] [--no-service] [--no-linger] [--replace-shim]
  vibeterm doctor [--install-dir <path>] [--json] [--bun-path <path>] [--fix]
  vibeterm upgrade [--version <version>] [--install-dir <path>] [--bun-path <path>] [--repair] [--service-name <name>] [--keep-backup] [--no-service] [--no-linger] [--allow-missing-native] [--allow-unverified]
  vibeterm uninstall [--install-dir <path>] [--yes] [--purge] [--delay-ms <n>]
  vibeterm user add <username>
  vibeterm user passwd <username> [--full-reset] [--yes]
  vibeterm user totp <username> [--code <digits>]
  vibeterm mesh reset-identity [--reset-tls] [--yes]
  vibeterm tls reset [--yes]
  vibeterm mesh keylog status
  vibeterm mesh reset-root [--yes]
  vibeterm mesh passkey remove-all [<username>]
  vibeterm direct enable|disable
  vibeterm relay enroll <url> [--password <p>] [--username <name>]
  vibeterm relay join <url> --token <r3.…> [--name <n>] [--no-restart] [--no-wait]
  vibeterm relay join <url> --tenant <id> [--password <p>] [--name <n>] [--ca-fingerprint <hex>] [--no-restart]
  vibeterm relay reauth <url> [--password <p>]
  vibeterm relay resend-token
  vibeterm relay pack upload
  vibeterm relay leave
  vibeterm relay list [--json]
  vibeterm relay unpin [--json]
  vibeterm relay trust refresh <url> --fingerprint <sha256-spki-hex>
  vibeterm relay status [--json]
  vibeterm relay tenants [--json]
  vibeterm relay metrics [--members] [--json]
  vibeterm relay passwd [--clear] [--kick|--keep] [--force]
  vibeterm relay kick <tenantId> [--force]
  vibeterm relay-admin passwd [--clear] [--kick|--keep] [--force]
  vibeterm relay-admin kick <tenantId> [--force]
  vibeterm relay remove <tenantId> [--yes]
  vibeterm relay quota <tenantId|default> [--max-nodes <n>] [--max-streams <n>] [--bandwidth <KBps>|unlimited] [--max-file-mb <MB>|none] [--inherit]
  vibeterm relay limits [--max-tenants <n>|none] [--total-bandwidth-kb <KBps>|none] [--fair-share on|off]
  vibeterm relay label <tenantId> <text>

Client commands (talk to a gateway over HTTP/WS, same security boundary as the web UI):
  vibeterm login|auth|logout|whoami|api|nodes|devices|tmux|sessions|term|files|cp|port|share|watch|agent|settings|exec|rsh|forward|token|system
  Run vibeterm <group> --help for the options of one group.
  rsh: ssh-compatible remote execution (works with rsync, git, scp); the vibeterm-rsh launcher is equivalent to vibeterm rsh.
  forward: port forwarding (-L / -R).
  token: manage access tokens.

Password prompting (add / passwd / totp / reset-root / relay join):
  TTY: hidden input with confirmation where required; empty rejected.
  Non-TTY: VIBETERM_PASSWORD (VIBETERM_PASSWORD_OLD for passwd). NFKC is applied by deriveSeed.
  Destructive recovery confirmation: TTY requires typing yes; non-TTY requires --yes.
  --full-reset (passwd): also remove all passkeys and two-step verification and sign out everywhere
  user totp: verify a code (--code or VIBETERM_TOTP) before saving; a mismatch writes nothing

relay join --token:
  Waits for approval by default (up to 10 minutes, also without a TTY); approve with "Confirm join" on the device that created the join code.
  --no-wait: print the pending state and exit 0 right away; the node appears on the other devices once approved. Scripts should pass it.
  Exit codes: 0 joined (or --no-wait); 1 failed or no approval in time (the request stays pending); 130 Ctrl+C (stops waiting, the request stays pending).
  With --no-restart or without a service manager, restart VibeTerm after approval; the final line says so.

Init shim ownership:
  --replace-shim: replace managed PATH shims owned by another install (or with unknown ownership).
  --stun-servers <list>: ${STUN_SERVERS_FLAG_HELP}.

Service (init / upgrade):
  --no-linger: skip enabling systemd linger (by default the Linux user service keeps running after logout).

Global flags:
  --lang <en|zh-CN>
  --help`;

const HELP_ZH = `VibeTerm CLI（tmex 仍可作为别名使用）

用法：
  vibeterm init [--role standalone|node|relay|relay,node] [--install-dir <path>] [--host <host>] [--port <port>] [--db-path <path>] [--autostart <true|false>] [--service-name <name>] [--no-interactive] [--bun-path <path>] [--install-deps] [--skip-dep-check] [--force] [--relay-public-url <url>] [--public-port <port>] [--peer-port <port>] [--stun-servers <list>] [--no-service] [--no-linger] [--replace-shim]
  vibeterm doctor [--install-dir <path>] [--json] [--bun-path <path>] [--fix]
  vibeterm upgrade [--version <version>] [--install-dir <path>] [--bun-path <path>] [--repair] [--service-name <name>] [--keep-backup] [--no-service] [--no-linger] [--allow-missing-native] [--allow-unverified]
  vibeterm uninstall [--install-dir <path>] [--yes] [--purge] [--delay-ms <n>]
  vibeterm user add <username>
  vibeterm user passwd <username> [--full-reset] [--yes]
  vibeterm user totp <username> [--code <digits>]
  vibeterm mesh reset-identity [--reset-tls] [--yes]
  vibeterm tls reset [--yes]
  vibeterm mesh keylog status
  vibeterm mesh reset-root [--yes]
  vibeterm mesh passkey remove-all [<username>]
  vibeterm direct enable|disable
  vibeterm relay enroll <url> [--password <p>] [--username <name>]
  vibeterm relay join <url> --token <r3.…> [--name <n>] [--no-restart] [--no-wait]
  vibeterm relay join <url> --tenant <id> [--password <p>] [--name <n>] [--ca-fingerprint <hex>] [--no-restart]
  vibeterm relay reauth <url> [--password <p>]
  vibeterm relay resend-token
  vibeterm relay pack upload
  vibeterm relay leave
  vibeterm relay list [--json]
  vibeterm relay unpin [--json]
  vibeterm relay trust refresh <url> --fingerprint <sha256-spki-hex>
  vibeterm relay status [--json]
  vibeterm relay tenants [--json]
  vibeterm relay metrics [--members] [--json]
  vibeterm relay passwd [--clear] [--kick|--keep] [--force]
  vibeterm relay kick <tenantId> [--force]
  vibeterm relay-admin passwd [--clear] [--kick|--keep] [--force]
  vibeterm relay-admin kick <tenantId> [--force]
  vibeterm relay remove <tenantId> [--yes]
  vibeterm relay quota <tenantId|default> [--max-nodes <n>] [--max-streams <n>] [--bandwidth <KBps>|unlimited] [--max-file-mb <MB>|none] [--inherit]
  vibeterm relay limits [--max-tenants <n>|none] [--total-bandwidth-kb <KBps>|none] [--fair-share on|off]
  vibeterm relay label <tenantId> <text>

客户端命令（经 HTTP/WS 访问网关，安全边界与网页端完全一致）：
  vibeterm login|auth|logout|whoami|api|nodes|devices|tmux|sessions|term|files|cp|port|share|watch|agent|settings|exec|rsh|forward|token|system
  用 vibeterm <组名> --help 查看某一组的用法。
  rsh：与 ssh 兼容的远程执行（可用于 rsync、git、scp）；vibeterm-rsh 启动器等价于 vibeterm rsh。
  forward：端口转发（-L / -R）。
  token：管理访问令牌。

密码输入（add / passwd / totp / reset-root / relay join）：
  TTY：隐藏输入，需要时二次确认；拒绝空密码。
  非 TTY：VIBETERM_PASSWORD（passwd 的旧密码用 VIBETERM_PASSWORD_OLD）。NFKC 由 deriveSeed 处理。
  破坏性恢复确认：TTY 必须输入完整 yes；非 TTY 必须传 --yes。
  --full-reset（passwd）：同时移除所有通行密钥、两步验证并注销全部会话
  user totp：先核对验证码（--code 或 VIBETERM_TOTP）再写入；不匹配则不保存

relay join --token：
  默认等待批准（最长 10 分钟，非 TTY 同样等待）；请在生成加入码的设备上点「确认加入」。
  --no-wait：只提示等待批准并立即以 0 退出，批准后本机出现在其他设备的节点页；脚本应加此参数。
  退出码：0 已加入（或 --no-wait）；1 失败或超时未批准（申请仍然有效）；130 Ctrl+C（只停止等待，申请仍然有效）。
  使用 --no-restart 或平台没有服务管理器时，批准后需手动重启 VibeTerm，最后一行会提示。

初始化命令入口：
  --replace-shim：替换属于其他安装或归属未知的托管 PATH shim。
  --stun-servers <list>：默认使用随发行版分发的内置列表；\`none\` 表示禁用。

服务（init / upgrade）：
  --no-linger：不启用 systemd linger（默认启用，登出后 Linux 用户服务继续运行）。

全局参数：
  --lang <en|zh-CN>
  --help`;

export function cliHelpText(lang: CliLang): string {
  return lang === 'zh-CN' ? HELP_ZH : HELP_EN;
}
