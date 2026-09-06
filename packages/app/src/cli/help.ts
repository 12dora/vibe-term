import type { CliLang } from '../i18n';

const HELP_EN = `VibeTerm CLI (tmex remains available as an alias)

Usage:
  vibeterm init [--role standalone|node|hub,node|relay|relay,node] [--no-interactive --install-dir <path> --host <host> --port <port> --db-path <path> --autostart <true|false> --bun-path <path> --install-deps --skip-dep-check] [--hub-url <url>] [--hub-public-url <url>] [--public-port <port>] [--peer-port <port>] [--no-service]
  vibeterm doctor [--install-dir <path>] [--json] [--bun-path <path>] [--fix]
  vibeterm upgrade [--version <version>] [--install-dir <path>] [--bun-path <path>] [--repair] [--keep-backup] [--no-service] [--allow-missing-native] [--allow-unverified]
  vibeterm uninstall [--install-dir <path>] [--yes] [--purge] [--delay-ms <n>]
  vibeterm hub user add <username>
  vibeterm hub user passwd <username> [--full-reset]
  vibeterm hub user totp <username>
  vibeterm hub user reset
  vibeterm hub join <https-url> --token <t> | --password [<p>] [--totp <code>] [--name <n>] [--insecure-local] [--no-restart]
  vibeterm hub leave [--no-restart]
  vibeterm hub standby --public-url <https-url> [--priority <n>] [--insecure-local] [--no-restart]
  vibeterm hub promote [--yes] [--no-restart]
  vibeterm hub demote [--no-restart]
  vibeterm hub list
  vibeterm hub allow <nodeId> [<nodeId>...] [--no-restart]
  vibeterm hub disallow <nodeId> [--no-restart]
  vibeterm mesh reset-root
  vibeterm enroll [--ttl 10m]
  vibeterm direct enable|disable
  vibeterm relay enroll <url> [--password <p>] [--username <name>]
  vibeterm relay join <url> --tenant <id> [--password <p>] [--name <n>] [--ca-fingerprint <hex>] [--no-restart]
  vibeterm relay reauth <url> [--password <p>]
  vibeterm relay leave
  vibeterm relay list [--json]
  vibeterm relay status [--json]
  vibeterm relay tenants [--json]
  vibeterm relay passwd [--clear] [--kick|--keep]
  vibeterm relay kick <tenantId>
  vibeterm relay remove <tenantId> [--yes]
  vibeterm relay quota <tenantId|default> [--max-nodes <n>] [--max-streams <n>] [--bandwidth <KBps>|unlimited] [--max-file-mb <MB>|none] [--inherit]
  vibeterm relay limits [--max-tenants <n>|none] [--total-bandwidth-kb <KBps>|none] [--fair-share on|off]
  vibeterm relay label <tenantId> <text>

Password prompting (add / passwd / totp / reset-root / enroll / hub join --password / relay join):
  TTY: hidden input with confirmation where required; empty rejected.
  Non-TTY: VIBETERM_PASSWORD (VIBETERM_PASSWORD_OLD for passwd; VIBETERM_TOTP for hub join TOTP). NFKC is applied by deriveSeed.
  --full-reset (passwd): also remove all passkeys and two-step verification and sign out everywhere

Global flags:
  --lang <en|zh-CN>
  --help`;

const HELP_ZH = `VibeTerm CLI（tmex 仍可作为别名使用）

用法：
  vibeterm init [--role standalone|node|hub,node|relay|relay,node] [--no-interactive --install-dir <path> --host <host> --port <port> --db-path <path> --autostart <true|false> --bun-path <path> --install-deps --skip-dep-check] [--hub-url <url>] [--hub-public-url <url>] [--public-port <port>] [--peer-port <port>] [--no-service]
  vibeterm doctor [--install-dir <path>] [--json] [--bun-path <path>] [--fix]
  vibeterm upgrade [--version <version>] [--install-dir <path>] [--bun-path <path>] [--repair] [--keep-backup] [--no-service] [--allow-missing-native] [--allow-unverified]
  vibeterm uninstall [--install-dir <path>] [--yes] [--purge] [--delay-ms <n>]
  vibeterm hub user add <username>
  vibeterm hub user passwd <username> [--full-reset]
  vibeterm hub user totp <username>
  vibeterm hub user reset
  vibeterm hub join <https-url> --token <t> | --password [<p>] [--totp <code>] [--name <n>] [--insecure-local] [--no-restart]
  vibeterm hub leave [--no-restart]
  vibeterm hub standby --public-url <https-url> [--priority <n>] [--insecure-local] [--no-restart]
  vibeterm hub promote [--yes] [--no-restart]
  vibeterm hub demote [--no-restart]
  vibeterm hub list
  vibeterm hub allow <nodeId> [<nodeId>...] [--no-restart]
  vibeterm hub disallow <nodeId> [--no-restart]
  vibeterm mesh reset-root
  vibeterm enroll [--ttl 10m]
  vibeterm direct enable|disable
  vibeterm relay enroll <url> [--password <p>] [--username <name>]
  vibeterm relay join <url> --tenant <id> [--password <p>] [--name <n>] [--ca-fingerprint <hex>] [--no-restart]
  vibeterm relay reauth <url> [--password <p>]
  vibeterm relay leave
  vibeterm relay list [--json]
  vibeterm relay status [--json]
  vibeterm relay tenants [--json]
  vibeterm relay passwd [--clear] [--kick|--keep]
  vibeterm relay kick <tenantId>
  vibeterm relay remove <tenantId> [--yes]
  vibeterm relay quota <tenantId|default> [--max-nodes <n>] [--max-streams <n>] [--bandwidth <KBps>|unlimited] [--max-file-mb <MB>|none] [--inherit]
  vibeterm relay limits [--max-tenants <n>|none] [--total-bandwidth-kb <KBps>|none] [--fair-share on|off]
  vibeterm relay label <tenantId> <text>

密码输入（add / passwd / totp / reset-root / enroll / hub join --password / relay join）：
  TTY：隐藏输入，需要时二次确认；拒绝空密码。
  非 TTY：VIBETERM_PASSWORD（passwd 的旧密码用 VIBETERM_PASSWORD_OLD；hub join 的 TOTP 用 VIBETERM_TOTP）。NFKC 由 deriveSeed 处理。
  --full-reset（passwd）：同时移除所有通行密钥、两步验证并注销全部会话

全局参数：
  --lang <en|zh-CN>
  --help`;

export function cliHelpText(lang: CliLang): string {
  return lang === 'zh-CN' ? HELP_ZH : HELP_EN;
}
