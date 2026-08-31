import type { CliLang } from '../i18n';

const HELP_EN = `tmex CLI

Usage:
  tmex init [--role standalone|node|hub,node] [--no-interactive --install-dir <path> --host <host> --port <port> --db-path <path> --autostart <true|false> --bun-path <path> --install-deps --skip-dep-check] [--hub-url <url>] [--hub-public-url <url>] [--peer-port <port>] [--no-service]
  tmex doctor [--install-dir <path>] [--json] [--bun-path <path>] [--fix]
  tmex upgrade [--version <version>] [--install-dir <path>] [--bun-path <path>] [--repair] [--keep-backup] [--no-service] [--allow-missing-native]
  tmex uninstall [--install-dir <path>] [--yes] [--purge]
  tmex hub user add <username>
  tmex hub user passwd <username>
  tmex hub user totp <username>
  tmex hub user reset
  tmex hub join <https-url> --token <t> [--name <n>] [--insecure-local] [--no-restart]
  tmex hub leave [--no-restart]
  tmex mesh reset-root
  tmex enroll [--ttl 10m]
  tmex direct enable|disable

Password prompting (add / passwd / totp / reset-root / enroll):
  TTY: hidden input with confirmation where required; empty rejected.
  Non-TTY: TMEX_PASSWORD (TMEX_PASSWORD_OLD for passwd). NFKC is applied by deriveSeed.

Global flags:
  --lang <en|zh-CN>
  --help`;

const HELP_ZH = `tmex CLI

用法：
  tmex init [--role standalone|node|hub,node] [--no-interactive --install-dir <path> --host <host> --port <port> --db-path <path> --autostart <true|false> --bun-path <path> --install-deps --skip-dep-check] [--hub-url <url>] [--hub-public-url <url>] [--peer-port <port>] [--no-service]
  tmex doctor [--install-dir <path>] [--json] [--bun-path <path>] [--fix]
  tmex upgrade [--version <version>] [--install-dir <path>] [--bun-path <path>] [--repair] [--keep-backup] [--no-service] [--allow-missing-native]
  tmex uninstall [--install-dir <path>] [--yes] [--purge]
  tmex hub user add <username>
  tmex hub user passwd <username>
  tmex hub user totp <username>
  tmex hub user reset
  tmex hub join <https-url> --token <t> [--name <n>] [--insecure-local] [--no-restart]
  tmex hub leave [--no-restart]
  tmex mesh reset-root
  tmex enroll [--ttl 10m]
  tmex direct enable|disable

密码输入（add / passwd / totp / reset-root / enroll）：
  TTY：隐藏输入，需要时二次确认；拒绝空密码。
  非 TTY：TMEX_PASSWORD（passwd 的旧密码用 TMEX_PASSWORD_OLD）。NFKC 由 deriveSeed 处理。

全局参数：
  --lang <en|zh-CN>
  --help`;

export function cliHelpText(lang: CliLang): string {
  return lang === 'zh-CN' ? HELP_ZH : HELP_EN;
}
