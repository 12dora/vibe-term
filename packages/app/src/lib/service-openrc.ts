// OpenRC 系统服务：/etc/init.d/<服务名>，command_user 为安装用户，supervise-daemon 负责重拉。
// 非 root 安装时写一条只放行 `rc-service <服务名> start|stop|restart|status` 的 sudoers 规则，
// 之后网页升级 / 重启不再需要密码。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { t } from '../i18n';
import { errorMessage } from './error-message';
import { pathExists } from './fs-utils';
import type { RunCommandResult } from './process';
import {
  OpenrcPrivilegeError,
  type OpenrcRuntime,
  commandDetail,
  createOpenrcRuntime,
  expectSuccess,
} from './service-openrc-privilege';
import type {
  ServiceDeps,
  ServiceIdentityOptions,
  ServiceInstallOptions,
  ServiceStatus,
} from './service-types';

export const OPENRC_INIT_DIR = '/etc/init.d';
export const SUDOERS_DIR = '/etc/sudoers.d';

const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const SUDOERS_ACTIONS = ['start', 'stop', 'restart', 'status'] as const;

export interface OpenrcScriptOptions {
  serviceName: string;
  runScriptPath: string;
  installDir: string;
  user: string;
  group?: string;
  homeDir: string;
}

function shellQuote(value: string): string {
  return `"${value.replace(/[\\"$`]/g, (ch) => `\\${ch}`)}"`;
}

function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name)) throw new Error(t('service.openrc.invalidName', { name }));
}

export function openrcLogPaths(installDir: string): { stdout: string; stderr: string } {
  return { stdout: join(installDir, 'vibeterm.log'), stderr: join(installDir, 'vibeterm.err.log') };
}

export function buildOpenrcInitScript(options: OpenrcScriptOptions): string {
  const logs = openrcLogPaths(options.installDir);
  const commandUser = options.group ? `${options.user}:${options.group}` : options.user;
  return `#!/sbin/openrc-run
# Written by VibeTerm. Reinstall or upgrade VibeTerm to refresh this file.

description=${shellQuote(`VibeTerm (${options.serviceName})`)}
supervisor=supervise-daemon
command=${shellQuote(options.runScriptPath)}
command_args=""
command_user=${shellQuote(commandUser)}
directory=${shellQuote(options.installDir)}
pidfile="/run/\${RC_SVCNAME}.pid"
output_log=${shellQuote(logs.stdout)}
error_log=${shellQuote(logs.stderr)}
respawn_delay=3
respawn_max=0
retry="TERM/20/KILL/5"
rc_cgroup_cleanup="no"

depend() {
	want net
	after firewall
}

start_pre() {
	export HOME=${shellQuote(options.homeDir)}
	export USER=${shellQuote(options.user)}
	export LOGNAME=${shellQuote(options.user)}
	export VIBETERM_LOG_FILE=${shellQuote(logs.stdout)}
	export VIBETERM_LOG_ERR_FILE=${shellQuote(logs.stderr)}
	export VIBETERM_SERVICE_MANAGER="openrc"
}
`;
}

export function openrcSudoersFileName(serviceName: string): string {
  return `vibeterm-${serviceName.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

export function buildOpenrcSudoers(user: string, serviceName: string, rcService: string): string {
  const commands = SUDOERS_ACTIONS.map((action) => `${rcService} ${serviceName} ${action}`);
  return `# Written by VibeTerm: lets ${user} control the ${serviceName} OpenRC service.
${user} ALL=(root) NOPASSWD: ${commands.join(', ')}
`;
}

function initDirOf(deps?: ServiceDeps): string {
  return deps?.openrcInitDir ?? OPENRC_INIT_DIR;
}

export function openrcScriptPath(serviceName: string, deps?: ServiceDeps): string {
  return join(initDirOf(deps), serviceName);
}

async function readTextOrNull(path: string): Promise<string | null> {
  return await readFile(path, 'utf8').catch(() => null);
}

async function withStagedFile<T>(content: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-openrc-'));
  const path = join(dir, 'staged');
  try {
    await writeFile(path, content, { mode: 0o644 });
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => null);
  }
}

async function resolveGroup(runtime: OpenrcRuntime, deps?: ServiceDeps): Promise<string> {
  if (deps?.groupName !== undefined) return deps.groupName;
  const result = await runQuiet(runtime, 'id', ['-gn']);
  return result?.code === 0 ? result.stdout.trim() : '';
}

async function buildScriptFor(
  options: ServiceInstallOptions,
  runtime: OpenrcRuntime,
  deps?: ServiceDeps
): Promise<string> {
  const info = userInfo();
  const user = deps?.username ?? info.username;
  assertSafeName(user);
  return buildOpenrcInitScript({
    serviceName: options.serviceName,
    runScriptPath: options.runScriptPath,
    installDir: options.installDir,
    user,
    group: (await resolveGroup(runtime, deps)) || undefined,
    homeDir: deps?.homeDir ?? info.homedir,
  });
}

async function writeInitScript(
  runtime: OpenrcRuntime,
  scriptPath: string,
  script: string
): Promise<void> {
  if ((await readTextOrNull(scriptPath)) === script) return;
  await withStagedFile(script, (staged) =>
    expectSuccess(runtime, ['install', '-m', '0755', staged, scriptPath])
  );
}

async function runQuiet(
  runtime: OpenrcRuntime,
  command: string,
  args: string[]
): Promise<RunCommandResult | null> {
  return await runtime.run(command, args).catch(() => null);
}

async function sudoersInPlace(runtime: OpenrcRuntime, serviceName: string): Promise<boolean> {
  const args = ['-n', '-l', runtime.bin('rc-service'), serviceName, 'restart'];
  return (await runQuiet(runtime, 'sudo', args))?.code === 0;
}

async function ensureSudoersRule(
  runtime: OpenrcRuntime,
  serviceName: string,
  deps?: ServiceDeps
): Promise<void> {
  if (runtime.isRoot || (await sudoersInPlace(runtime, serviceName))) return;
  const user = deps?.username ?? userInfo().username;
  const content = buildOpenrcSudoers(user, serviceName, runtime.bin('rc-service'));
  const target = join(deps?.sudoersDir ?? SUDOERS_DIR, openrcSudoersFileName(serviceName));
  try {
    await withStagedFile(content, async (staged) => {
      await expectSuccess(runtime, ['visudo', '-cf', staged]);
      await expectSuccess(runtime, ['install', '-m', '0440', staged, target]);
    });
  } catch (err) {
    if (err instanceof OpenrcPrivilegeError) throw err;
    runtime.warn(`[service] ${t('service.openrc.sudoersSkipped', { detail: errorMessage(err) })}`);
  }
}

export function parseRunlevelMembership(output: string, serviceName: string): boolean {
  return output.split('\n').some((line) => line.split('|')[0]?.trim() === serviceName);
}

async function isInDefaultRunlevel(runtime: OpenrcRuntime, serviceName: string): Promise<boolean> {
  const result = await runQuiet(runtime, runtime.bin('rc-update'), ['show', 'default']);
  return result?.code === 0 && parseRunlevelMembership(result.stdout, serviceName);
}

async function syncRunlevel(
  runtime: OpenrcRuntime,
  serviceName: string,
  autostart: boolean
): Promise<void> {
  const enabled = await isInDefaultRunlevel(runtime, serviceName);
  if (autostart === enabled) return;
  const action = autostart ? 'add' : 'del';
  await expectSuccess(runtime, [runtime.bin('rc-update'), action, serviceName, 'default']);
}

async function isRunning(runtime: OpenrcRuntime, serviceName: string): Promise<boolean> {
  const result = await runQuiet(runtime, runtime.bin('rc-service'), [serviceName, 'status']);
  return result?.code === 0;
}

async function startOrRestart(runtime: OpenrcRuntime, serviceName: string): Promise<void> {
  const action = (await isRunning(runtime, serviceName)) ? 'restart' : 'start';
  await expectSuccess(runtime, [runtime.bin('rc-service'), serviceName, action]);
}

async function removeRegistration(
  runtime: OpenrcRuntime,
  serviceName: string,
  deps?: ServiceDeps
): Promise<void> {
  const scriptPath = openrcScriptPath(serviceName, deps);
  if (!(await pathExists(scriptPath))) return;
  await runtime.privileged([runtime.bin('rc-service'), serviceName, 'stop']);
  if (await isInDefaultRunlevel(runtime, serviceName)) {
    await expectSuccess(runtime, [runtime.bin('rc-update'), 'del', serviceName, 'default']);
  }
  await expectSuccess(runtime, ['rm', '-f', scriptPath]);
  if (!runtime.isRoot) {
    const sudoers = join(deps?.sudoersDir ?? SUDOERS_DIR, openrcSudoersFileName(serviceName));
    await runtime.privileged(['rm', '-f', sudoers]);
  }
}

export async function installOpenrcService(
  options: ServiceInstallOptions,
  deps?: ServiceDeps
): Promise<void> {
  assertSafeName(options.serviceName);
  const runtime = createOpenrcRuntime(deps);
  const legacy = options.legacyServiceName;
  if (legacy && legacy !== options.serviceName && SAFE_NAME.test(legacy)) {
    await removeRegistration(runtime, legacy, deps);
  }
  const script = await buildScriptFor(options, runtime, deps);
  await writeInitScript(runtime, openrcScriptPath(options.serviceName, deps), script);
  await ensureSudoersRule(runtime, options.serviceName, deps);
  await syncRunlevel(runtime, options.serviceName, options.autostart);
  await startOrRestart(runtime, options.serviceName);
}

function manualUninstallCommands(serviceName: string, deps?: ServiceDeps): string {
  const sudoers = join(deps?.sudoersDir ?? SUDOERS_DIR, openrcSudoersFileName(serviceName));
  return [
    `rc-service ${serviceName} stop`,
    `rc-update del ${serviceName} default`,
    `rm -f ${openrcScriptPath(serviceName, deps)} ${sudoers}`,
  ].join('; ');
}

export async function uninstallOpenrcService(
  serviceName: string,
  deps?: ServiceDeps
): Promise<void> {
  assertSafeName(serviceName);
  try {
    await removeRegistration(createOpenrcRuntime(deps), serviceName, deps);
  } catch (err) {
    throw new Error(
      t('service.openrc.uninstallManual', {
        commands: manualUninstallCommands(serviceName, deps),
        detail: errorMessage(err),
      })
    );
  }
}

/** 停服只在提权失败时抛错；rc-service 自身失败交给调用方的「是否真的停了」等待去判断。 */
export async function stopOpenrcService(
  serviceName: string,
  opts?: ServiceIdentityOptions
): Promise<void> {
  const runtime = createOpenrcRuntime(opts?.deps);
  const names = new Set([serviceName, opts?.legacyServiceName].filter(Boolean) as string[]);
  for (const name of names) {
    if (!SAFE_NAME.test(name)) continue;
    if (name !== serviceName && !(await pathExists(openrcScriptPath(name, opts?.deps)))) continue;
    await runtime.privileged([runtime.bin('rc-service'), name, 'stop']);
  }
}

export async function startOpenrcService(serviceName: string, deps?: ServiceDeps): Promise<void> {
  assertSafeName(serviceName);
  const runtime = createOpenrcRuntime(deps);
  await expectSuccess(runtime, [runtime.bin('rc-service'), serviceName, 'start']);
}

export async function restartOpenrcService(serviceName: string, deps?: ServiceDeps): Promise<void> {
  assertSafeName(serviceName);
  await startOrRestart(createOpenrcRuntime(deps), serviceName);
}

export async function queryOpenrcStatus(
  serviceName: string,
  deps?: ServiceDeps
): Promise<ServiceStatus> {
  const runtime = createOpenrcRuntime(deps);
  const installed = await pathExists(openrcScriptPath(serviceName, deps));
  const status = installed
    ? await runQuiet(runtime, runtime.bin('rc-service'), [serviceName, 'status'])
    : null;
  return {
    manager: 'openrc',
    installed,
    running: status?.code === 0,
    autostartEnabled: installed && (await isInDefaultRunlevel(runtime, serviceName)),
    detail: status ? commandDetail(status) || undefined : undefined,
  };
}
