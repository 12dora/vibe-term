// OpenRC 系统服务：/etc/init.d/<服务名>，command_user 为安装用户，supervise-daemon 负责重拉。
// 非 root 安装时写一条只放行 `rc-service <服务名> start|stop|restart|status` 的 sudoers 规则，
// 之后网页升级 / 重启不再需要密码。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { currentOsAccount } from '../../../shared/src/env/os-account';
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
  probeNopasswd,
} from './service-openrc-privilege';
import {
  OPENRC_INIT_DIR,
  SUDOERS_DIR,
  assertSafeName,
  buildOpenrcInitScript,
  buildOpenrcSudoers,
  isSafeOpenrcName,
  openrcSudoersFileName,
  parseOpenrcOwner,
} from './service-openrc-script';
import type {
  ServiceDeps,
  ServiceIdentityOptions,
  ServiceInstallOptions,
  ServiceStatus,
} from './service-types';

export {
  OPENRC_INIT_DIR,
  SUDOERS_DIR,
  buildOpenrcInitScript,
  buildOpenrcSudoers,
  openrcLogPaths,
  openrcSudoersFileName,
  parseOpenrcOwner,
} from './service-openrc-script';

export function openrcScriptPath(serviceName: string, deps?: ServiceDeps): string {
  return join(deps?.openrcInitDir ?? OPENRC_INIT_DIR, serviceName);
}

function sudoersPath(serviceName: string, deps?: ServiceDeps): string {
  return join(deps?.sudoersDir ?? SUDOERS_DIR, openrcSudoersFileName(serviceName));
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

async function runQuiet(
  runtime: OpenrcRuntime,
  command: string,
  args: string[]
): Promise<RunCommandResult | null> {
  return await runtime.run(command, args).catch(() => null);
}

/**
 * 只认 VibeTerm 写的脚本：没有托管标记的一律拒绝；属于另一个仍存在的安装目录时，
 * 除非 --force 也拒绝（多用户主机上第二次默认 init 不得抢走第一个用户的服务）。
 */
async function assertOwnedScript(
  scriptPath: string,
  content: string,
  installDir: string | undefined,
  force?: boolean
): Promise<void> {
  const owner = parseOpenrcOwner(content);
  if (!owner.managed) throw new Error(t('service.openrc.foreignScript', { path: scriptPath }));
  if (force || !installDir || !owner.installDir) return;
  if (resolve(owner.installDir) === resolve(installDir)) return;
  if (await pathExists(owner.installDir)) {
    throw new Error(
      t('service.openrc.ownedByOther', { path: scriptPath, installDir: owner.installDir })
    );
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
  const info = currentOsAccount();
  return buildOpenrcInitScript({
    serviceName: options.serviceName,
    runScriptPath: options.runScriptPath,
    installDir: options.installDir,
    user: deps?.username ?? info.username,
    group: (await resolveGroup(runtime, deps)) || undefined,
    homeDir: deps?.homeDir ?? info.homedir,
  });
}

async function writeInitScript(
  runtime: OpenrcRuntime,
  scriptPath: string,
  script: string,
  existing: string | null
): Promise<void> {
  if (existing === script) return;
  await withStagedFile(script, (staged) =>
    expectSuccess(runtime, [runtime.bin('install'), '-m', '0755', staged, scriptPath])
  );
}

/** 免密 `rc-service` 是否可用：root 恒可用；否则以白名单内的 status 探测。 */
export async function openrcControlReady(
  serviceName: string,
  deps?: ServiceDeps
): Promise<boolean> {
  const runtime = createOpenrcRuntime(deps);
  if (runtime.isRoot) return true;
  return await probeNopasswd(runtime.run, [runtime.bin('rc-service'), serviceName, 'status']);
}

async function installSudoersRule(
  runtime: OpenrcRuntime,
  serviceName: string,
  deps?: ServiceDeps
): Promise<void> {
  const user = deps?.username ?? currentOsAccount().username;
  const content = buildOpenrcSudoers(user, serviceName, runtime.bin('rc-service'));
  const target = sudoersPath(serviceName, deps);
  try {
    await withStagedFile(content, async (staged) => {
      await expectSuccess(runtime, [runtime.bin('visudo'), '-cf', staged]);
      await expectSuccess(runtime, [runtime.bin('install'), '-m', '0440', staged, target]);
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

interface RemoveOptions {
  installDir?: string;
  /** 迁移拆旧名时只在脚本存在才动手，避免每次升级都为不存在的旧名请求 sudo */
  onlyIfInstalled?: boolean;
  deps?: ServiceDeps;
}

/** 顺序：停服 → 退出 runlevel → 删 sudoers → 删脚本；中途中断后重跑仍能看到脚本并清干净。 */
async function removeRegistration(
  runtime: OpenrcRuntime,
  serviceName: string,
  options: RemoveOptions
): Promise<void> {
  const scriptPath = openrcScriptPath(serviceName, options.deps);
  const content = await readTextOrNull(scriptPath);
  if (content === null && options.onlyIfInstalled) return;
  if (content !== null) {
    await assertOwnedScript(scriptPath, content, options.installDir);
    await runtime.privileged([runtime.bin('rc-service'), serviceName, 'stop']);
  }
  const enabled = await isInDefaultRunlevel(runtime, serviceName);
  if (enabled) {
    await expectSuccess(runtime, [runtime.bin('rc-update'), 'del', serviceName, 'default']);
  }
  const sudoers = sudoersPath(serviceName, options.deps);
  // 非 root 读不了 0750 的 sudoers.d；只在本次确实有注册残留时才去删，避免无谓的 sudo 提示。
  const removeSudoers = runtime.isRoot ? await pathExists(sudoers) : content !== null || enabled;
  if (removeSudoers) await expectSuccess(runtime, [runtime.bin('rm'), '-f', sudoers]);
  if (content !== null) await expectSuccess(runtime, [runtime.bin('rm'), '-f', scriptPath]);
}

async function removeLegacyRegistration(
  runtime: OpenrcRuntime,
  options: ServiceInstallOptions,
  deps?: ServiceDeps
): Promise<void> {
  const legacy = options.legacyServiceName;
  if (!legacy || legacy === options.serviceName || !isSafeOpenrcName(legacy)) return;
  await removeRegistration(runtime, legacy, {
    installDir: options.installDir,
    onlyIfInstalled: true,
    deps,
  }).catch((err) => {
    if (err instanceof OpenrcPrivilegeError) throw err;
    runtime.warn(`[service] ${errorMessage(err)}`);
  });
}

/**
 * 安装 / 升级 / 回滚共用。脚本已是本安装的托管脚本时，写脚本、sudoers、runlevel 遇到
 * 非交互提权失败只告警，仍用免密 rc-service 拉起服务，网页升级不至于把节点停死。
 */
export async function installOpenrcService(
  options: ServiceInstallOptions,
  deps?: ServiceDeps
): Promise<void> {
  assertSafeName(options.serviceName);
  const runtime = createOpenrcRuntime(deps);
  const scriptPath = openrcScriptPath(options.serviceName, deps);
  const existing = await readTextOrNull(scriptPath);
  if (existing !== null) {
    await assertOwnedScript(scriptPath, existing, options.installDir, options.force);
  }
  const script = await buildScriptFor(options, runtime, deps);
  // 必须在任何提权之前探测，否则刚输过的 sudo 密码会让探测误判为免密可用。
  const controlReady = await openrcControlReady(options.serviceName, deps);
  try {
    await removeLegacyRegistration(runtime, options, deps);
    await writeInitScript(runtime, scriptPath, script, existing);
    if (!controlReady) await installSudoersRule(runtime, options.serviceName, deps);
    await syncRunlevel(runtime, options.serviceName, options.autostart);
  } catch (err) {
    if (!(err instanceof OpenrcPrivilegeError) || existing === null) throw err;
    const detail = errorMessage(err);
    runtime.warn(`[service] ${t('service.openrc.refreshSkipped', { detail })}`);
  }
  await startOrRestart(runtime, options.serviceName);
}

function manualUninstallCommands(serviceName: string, deps?: ServiceDeps): string {
  return [
    `rc-service ${serviceName} stop`,
    `rc-update del ${serviceName} default`,
    `rm -f ${sudoersPath(serviceName, deps)} ${openrcScriptPath(serviceName, deps)}`,
  ].join('; ');
}

export async function uninstallOpenrcService(
  serviceName: string,
  installDir?: string,
  deps?: ServiceDeps
): Promise<void> {
  assertSafeName(serviceName);
  try {
    await removeRegistration(createOpenrcRuntime(deps), serviceName, { installDir, deps });
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
    if (!isSafeOpenrcName(name)) continue;
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
