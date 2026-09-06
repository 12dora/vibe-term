import { readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureDir, pathExists, writeText } from './fs-utils';
import { type RunCommandResult, runCommand } from './process';

export const OOM_DROP_IN_FILENAME = 'vibeterm-oom.conf';

/** 改名前写出的 drop-in；已有机器上还留着，识别出来一并清理，避免两份同义配置并存。 */
export const LEGACY_OOM_DROP_IN_FILENAME = 'tmex-oom.conf';

/**
 * tmux ≥ 3.6 把每个 pane 放进独立的 systemd 用户 scope；systemd 默认 `DefaultOOMPolicy=stop`
 * 会在内核 OOM 杀掉 scope 内任意进程后停掉整个 scope（连 shell 一起），窗口随之消失。
 */
export const OOM_DROP_IN_CONTENT = `# Written by VibeTerm — do not edit (uninstall VibeTerm to drop this file).
# tmux >= 3.6 runs every pane in its own systemd user scope. With systemd's default
# DefaultOOMPolicy=stop, a kernel OOM kill of any process inside a pane stops the whole
# scope: the shell dies and the tmux window disappears. "continue" keeps the pane alive
# and lets the kernel kill only the offending process.
[Manager]
DefaultOOMPolicy=continue
`;

/** 改名前写出的 drop-in 内容，逐字节比对用于确认那份文件确实是我们写的。 */
export const LEGACY_OOM_DROP_IN_CONTENT = `# Written by tmex — do not edit (remove tmex to drop this file).
# tmux >= 3.6 runs every pane in its own systemd user scope. With systemd's default
# DefaultOOMPolicy=stop, a kernel OOM kill of any process inside a pane stops the whole
# scope: the shell dies and the tmux window disappears. "continue" keeps the pane alive
# and lets the kernel kill only the offending process.
[Manager]
DefaultOOMPolicy=continue
`;

const EXPLICIT_POLICY = /^\s*DefaultOOMPolicy\s*=\s*\S/m;

export interface SystemdOomPolicyPaths {
  userConf: string;
  dropInDir: string;
  dropIn: string;
  legacyDropIn: string;
}

export function systemdOomPolicyPaths(configDir?: string): SystemdOomPolicyPaths {
  const base = configDir ?? join(homedir(), '.config', 'systemd');
  const dropInDir = join(base, 'user.conf.d');
  return {
    userConf: join(base, 'user.conf'),
    dropInDir,
    dropIn: join(dropInDir, OOM_DROP_IN_FILENAME),
    legacyDropIn: join(dropInDir, LEGACY_OOM_DROP_IN_FILENAME),
  };
}

export function declaresDefaultOomPolicy(content: string | null): boolean {
  if (content === null) return false;
  return EXPLICIT_POLICY.test(content);
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function listDropIns(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith('.conf') && name !== OOM_DROP_IN_FILENAME).sort();
  } catch {
    return [];
  }
}

/** 用户已显式配置过 DefaultOOMPolicy 时返回该文件路径，VibeTerm 不覆盖用户意图。 */
export async function findExplicitOomPolicy(paths: SystemdOomPolicyPaths): Promise<string | null> {
  if (declaresDefaultOomPolicy(await readTextOrNull(paths.userConf))) return paths.userConf;
  for (const name of await listDropIns(paths.dropInDir)) {
    const path = join(paths.dropInDir, name);
    const content = await readTextOrNull(path);
    // 改名前我们自己写的那份不算「用户意图」，否则升级后永远跳过写新文件。
    if (name === LEGACY_OOM_DROP_IN_FILENAME && content === LEGACY_OOM_DROP_IN_CONTENT) continue;
    if (declaresDefaultOomPolicy(content)) return path;
  }
  return null;
}

/** 只删逐字节等于我们写过的那份旧 drop-in；用户改过的一律保留。 */
async function removeLegacyDropIn(paths: SystemdOomPolicyPaths): Promise<boolean> {
  if ((await readTextOrNull(paths.legacyDropIn)) !== LEGACY_OOM_DROP_IN_CONTENT) return false;
  try {
    await rm(paths.legacyDropIn, { force: true });
    return true;
  } catch {
    return false;
  }
}

export type OomDropInOutcome = 'written' | 'unchanged' | 'skipped-explicit' | 'failed';
export type OomDropInRemoval = 'removed' | 'kept-modified' | 'absent' | 'failed';

export interface SystemdOomPolicyDeps {
  configDir?: string;
  run?: (command: string, args: string[]) => Promise<RunCommandResult>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

const RELOAD_TIMEOUT_MS = 10_000;

function defaultRun(command: string, args: string[]): Promise<RunCommandResult> {
  return runCommand(command, args, { timeoutMs: RELOAD_TIMEOUT_MS });
}

async function reloadManagerConfig(deps: SystemdOomPolicyDeps): Promise<void> {
  const run = deps.run ?? defaultRun;
  const warn = deps.warn ?? console.warn;
  const reexec = await run('systemctl', ['--user', 'daemon-reexec']).catch(
    (error: unknown) => ({ code: 1, stdout: '', stderr: String(error) }) satisfies RunCommandResult
  );
  if (reexec.code === 0) return;

  const reload = await run('systemctl', ['--user', 'daemon-reload']).catch(
    (error: unknown) => ({ code: 1, stdout: '', stderr: String(error) }) satisfies RunCommandResult
  );
  if (reload.code === 0) {
    warn('[service] systemctl --user daemon-reexec failed; fell back to daemon-reload');
    return;
  }
  warn(
    `[service] could not reload the systemd user manager: ${(reexec.stderr || reexec.stdout || '').trim()} — DefaultOOMPolicy=continue applies after the next login or daemon-reexec`
  );
}

/**
 * 托管安装/升级时写入 `~/.config/systemd/user.conf.d/vibeterm-oom.conf`，幂等；
 * 用户已显式配置 DefaultOOMPolicy 时跳过。任何失败只告警，绝不让安装失败。
 */
export async function ensureSystemdOomPolicyDropIn(
  deps: SystemdOomPolicyDeps = {}
): Promise<OomDropInOutcome> {
  const paths = systemdOomPolicyPaths(deps.configDir);
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;

  try {
    const explicit = await findExplicitOomPolicy(paths);
    if (explicit !== null) {
      log(
        `[service] DefaultOOMPolicy already set in ${explicit}; leaving systemd OOM policy as is`
      );
      return 'skipped-explicit';
    }

    if ((await readTextOrNull(paths.dropIn)) === OOM_DROP_IN_CONTENT) {
      await removeLegacyDropIn(paths);
      return 'unchanged';
    }

    await ensureDir(paths.dropInDir);
    await writeText(paths.dropIn, OOM_DROP_IN_CONTENT);
    await removeLegacyDropIn(paths);
    log(`[service] wrote ${paths.dropIn} (DefaultOOMPolicy=continue)`);
  } catch (error) {
    warn(
      `[service] could not write ${paths.dropIn}: ${String(error)} — a kernel OOM kill inside a tmux pane may close the whole window`
    );
    return 'failed';
  }

  await reloadManagerConfig(deps);
  return 'written';
}

/** 卸载时只删自己写的那份（逐字节相同），用户改过的一律保留。 */
export async function removeSystemdOomPolicyDropIn(
  deps: SystemdOomPolicyDeps = {}
): Promise<OomDropInRemoval> {
  const paths = systemdOomPolicyPaths(deps.configDir);
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;

  const removedLegacy = await removeLegacyDropIn(paths);

  if (!(await pathExists(paths.dropIn))) return removedLegacy ? 'removed' : 'absent';
  const current = await readTextOrNull(paths.dropIn);
  if (current !== OOM_DROP_IN_CONTENT) {
    log(`[service] kept ${paths.dropIn} (modified since VibeTerm wrote it)`);
    return 'kept-modified';
  }

  try {
    await rm(paths.dropIn, { force: true });
  } catch (error) {
    warn(`[service] could not remove ${paths.dropIn}: ${String(error)}`);
    return 'failed';
  }
  await reloadManagerConfig(deps);
  return 'removed';
}

export const SYSTEMD_OOM_POLICY_WARNING =
  '[service] systemd DefaultOOMPolicy=stop: a kernel OOM kill inside a tmux pane will close the whole window — run `vibeterm upgrade` (or write ~/.config/systemd/user.conf.d/vibeterm-oom.conf with DefaultOOMPolicy=continue)';

/** `systemctl --user show -p DefaultOOMPolicy` 既可能输出 `DefaultOOMPolicy=stop` 也可能只有值。 */
export function parseDefaultOomPolicy(output: string | null): string | null {
  if (output === null) return null;
  const line = output.trim();
  if (line === '') return null;
  const match = /^DefaultOOMPolicy\s*=\s*(.*)$/.exec(line);
  return (match ? match[1] : line).trim().toLowerCase() || null;
}

/** `tmux -V` → `tmux 3.6` / `tmux 3.5a` / `tmux next-3.7`；解析不出返回 null。 */
export function parseTmuxVersion(output: string | null): { major: number; minor: number } | null {
  if (output === null) return null;
  const match = /(\d+)\.(\d+)/.exec(output);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** tmux 从 3.6 起给每个 pane 建 systemd scope；版本未知时按「可能受影响」处理。 */
export function tmuxUsesSystemdScopes(versionOutput: string | null): boolean {
  const version = parseTmuxVersion(versionOutput);
  if (version === null) return true;
  return version.major > 3 || (version.major === 3 && version.minor >= 6);
}

export function shouldWarnAboutOomPolicy(
  policyOutput: string | null,
  tmuxVersionOutput: string | null
): boolean {
  if (parseDefaultOomPolicy(policyOutput) !== 'stop') return false;
  return tmuxUsesSystemdScopes(tmuxVersionOutput);
}
