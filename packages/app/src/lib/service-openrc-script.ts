// OpenRC init 脚本与 sudoers 规则的纯函数生成与校验。
// supervise-daemon.sh 以 root 对 command / directory / output_log / error_log / command_user 做
// 不带内层引号的二次 eval，所以这些值只允许安全字符集，引号只能防第一次求值。
import { join } from 'node:path';
import { t } from '../i18n';

export const OPENRC_INIT_DIR = '/etc/init.d';
export const SUDOERS_DIR = '/etc/sudoers.d';
export const OPENRC_MARKER = '# vibeterm-openrc-service';
const INSTALL_DIR_TAG = '# vibeterm-install-dir: ';

const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const SAFE_PATH = /^\/[A-Za-z0-9_./:@+-]*$/;
const SUDOERS_ACTIONS = ['start', 'stop', 'restart', 'status'] as const;

export interface OpenrcScriptOptions {
  serviceName: string;
  runScriptPath: string;
  installDir: string;
  user: string;
  group?: string;
  homeDir: string;
}

export function isSafeOpenrcName(name: string): boolean {
  return SAFE_NAME.test(name);
}

export function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name)) throw new Error(t('service.openrc.invalidName', { name }));
}

export function assertSafePath(path: string): void {
  if (!SAFE_PATH.test(path)) throw new Error(t('service.openrc.unsafePath', { path }));
}

function singleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function openrcLogPaths(installDir: string): { stdout: string; stderr: string } {
  return { stdout: join(installDir, 'vibeterm.log'), stderr: join(installDir, 'vibeterm.err.log') };
}

function assertScriptInputs(options: OpenrcScriptOptions): void {
  assertSafeName(options.serviceName);
  assertSafeName(options.user);
  if (options.group) assertSafeName(options.group);
  assertSafePath(options.installDir);
  assertSafePath(options.runScriptPath);
  assertSafePath(options.homeDir);
}

export function buildOpenrcInitScript(options: OpenrcScriptOptions): string {
  assertScriptInputs(options);
  const q = singleQuote;
  const logs = openrcLogPaths(options.installDir);
  const commandUser = options.group ? `${options.user}:${options.group}` : options.user;
  return `#!/sbin/openrc-run
${OPENRC_MARKER}
${INSTALL_DIR_TAG}${options.installDir}
# Written by VibeTerm. Reinstall or upgrade VibeTerm to refresh this file.

description=${q(`VibeTerm (${options.serviceName})`)}
supervisor=supervise-daemon
command=${q(options.runScriptPath)}
command_args=''
command_user=${q(commandUser)}
directory=${q(options.installDir)}
pidfile="/run/\${RC_SVCNAME}.pid"
output_log=${q(logs.stdout)}
error_log=${q(logs.stderr)}
respawn_delay=3
respawn_max=0
retry='TERM/20/KILL/5'
rc_cgroup_cleanup='no'

depend() {
	want net
	after firewall
}

start_pre() {
	export HOME=${q(options.homeDir)}
	export USER=${q(options.user)}
	export LOGNAME=${q(options.user)}
	export VIBETERM_LOG_FILE=${q(logs.stdout)}
	export VIBETERM_LOG_ERR_FILE=${q(logs.stderr)}
	export VIBETERM_SERVICE_MANAGER='openrc'
}
`;
}

export interface OpenrcScriptOwner {
  managed: boolean;
  installDir: string | null;
}

export function parseOpenrcOwner(content: string): OpenrcScriptOwner {
  const lines = content.split('\n');
  const managed = lines.some((line) => line.trim() === OPENRC_MARKER);
  const tagged = lines.find((line) => line.startsWith(INSTALL_DIR_TAG));
  return { managed, installDir: tagged ? tagged.slice(INSTALL_DIR_TAG.length).trim() : null };
}

export function openrcSudoersFileName(serviceName: string): string {
  return `vibeterm-${serviceName.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

export function buildOpenrcSudoers(user: string, serviceName: string, rcService: string): string {
  assertSafeName(user);
  assertSafeName(serviceName);
  assertSafePath(rcService);
  const commands = SUDOERS_ACTIONS.map((action) => `${rcService} ${serviceName} ${action}`);
  return `# Written by VibeTerm: lets ${user} control the ${serviceName} OpenRC service.
${user} ALL=(root) NOPASSWD: ${commands.join(', ')}
`;
}
