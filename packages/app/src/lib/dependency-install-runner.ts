import { t } from '../i18n';
import { checkBunVersion } from './bun';
import {
  type DepInstallPlan,
  type DepName,
  type InstallCommand,
  isSudoAvailable as detectSudoAvailable,
  isRootUid,
  resolveInstallCommand,
} from './dep-install';
import { type RunCommandResult, runCommand } from './process';
import { promptConfirm as defaultPromptConfirm } from './prompt';
import { checkTmuxVersion } from './tmux';

export type CommandSpawner = (
  command: string,
  args: string[],
  options?: { stdio?: 'inherit' | 'pipe'; timeoutMs?: number }
) => Promise<RunCommandResult>;

export type ConfirmPrompt = (
  ctx: { nonInteractive: boolean },
  message: string,
  defaultValue: boolean
) => Promise<boolean>;

export interface VersionCheckResult {
  ok: boolean;
}

export interface DependencyInstallRunnerDeps {
  runCommand?: CommandSpawner;
  promptConfirm?: ConfirmPrompt;
  checkBunVersion?: () => Promise<VersionCheckResult>;
  checkTmuxVersion?: () => Promise<VersionCheckResult>;
  isSudoAvailable?: () => Promise<boolean>;
  uid?: number | undefined;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface DependencyInstallOptions {
  nonInteractive: boolean;
  autoConfirm: boolean;
}

export type ResolvedInstallPlan =
  | { ok: false }
  | { ok: true; command: InstallCommand; fullCommand: string };

interface ResolvedRunnerDeps {
  runCommand: CommandSpawner;
  promptConfirm: ConfirmPrompt;
  checkBunVersion: () => Promise<VersionCheckResult>;
  checkTmuxVersion: () => Promise<VersionCheckResult>;
  isSudoAvailable: () => Promise<boolean>;
  uid: number | undefined;
  platform: NodeJS.Platform;
  log: (message: string) => void;
  error: (message: string) => void;
}

function resolveRunnerDeps(deps: DependencyInstallRunnerDeps = {}): ResolvedRunnerDeps {
  return {
    runCommand: deps.runCommand ?? runCommand,
    promptConfirm: deps.promptConfirm ?? defaultPromptConfirm,
    checkBunVersion: deps.checkBunVersion ?? checkBunVersion,
    checkTmuxVersion: deps.checkTmuxVersion ?? checkTmuxVersion,
    isSudoAvailable: deps.isSudoAvailable ?? detectSudoAvailable,
    uid: deps.uid ?? process.getuid?.(),
    platform: deps.platform ?? process.platform,
    log: deps.log ?? ((message) => console.log(message)),
    error: deps.error ?? ((message) => console.error(message)),
  };
}

function tmexLog(write: (message: string) => void, message: string): void {
  write(`[tmex] ${message}`);
}

function reportFailedInstall(dep: DepName, error: (message: string) => void): void {
  tmexLog(error, t('deps.install.failed', { dep }));
  tmexLog(error, t('deps.install.manual'));
}

function reportMissingCommands(
  plan: DepInstallPlan,
  deps: ResolvedRunnerDeps
): ResolvedInstallPlan {
  if (plan.dep === 'tmux' && deps.platform === 'darwin') {
    tmexLog(deps.error, t('deps.install.brewMissing'));
  } else {
    tmexLog(deps.error, t('deps.install.unknownDistro', { dep: plan.dep }));
  }
  tmexLog(deps.error, t('deps.install.manual'));
  return { ok: false };
}

async function ensureSudoReady(
  command: InstallCommand,
  options: DependencyInstallOptions,
  deps: ResolvedRunnerDeps
): Promise<boolean> {
  if (!command.requiresSudo || isRootUid(deps.uid) || !options.nonInteractive) {
    return true;
  }
  if (await deps.isSudoAvailable()) {
    return true;
  }
  tmexLog(deps.error, t('deps.install.sudoUnavailable'));
  return false;
}

export async function resolveInstallPlan(
  plan: DepInstallPlan,
  options: DependencyInstallOptions,
  deps: DependencyInstallRunnerDeps = {}
): Promise<ResolvedInstallPlan> {
  const resolved = resolveRunnerDeps(deps);
  const command = plan.commands[0];
  if (!command) {
    return reportMissingCommands(plan, resolved);
  }
  if (!(await ensureSudoReady(command, options, resolved))) {
    return { ok: false };
  }
  const fullCommand = resolveInstallCommand(command, resolved.uid);
  tmexLog(resolved.log, t('deps.install.hint', { command: fullCommand }));
  return { ok: true, command, fullCommand };
}

export async function confirmInstall(
  plan: DepInstallPlan,
  options: DependencyInstallOptions,
  deps: DependencyInstallRunnerDeps = {}
): Promise<boolean> {
  if (options.autoConfirm) return true;

  const resolved = resolveRunnerDeps(deps);
  if (options.nonInteractive) {
    tmexLog(resolved.error, t('deps.install.nonInteractive', { dep: plan.dep }));
    return false;
  }

  return resolved.promptConfirm(
    { nonInteractive: false },
    t('deps.install.confirm', { dep: plan.dep }),
    true
  );
}

async function spawnInstallCommand(
  fullCommand: string,
  spawn: CommandSpawner
): Promise<RunCommandResult | null> {
  if (fullCommand.includes('|')) {
    return spawn('sh', ['-c', fullCommand], { stdio: 'inherit' }).catch(() => null);
  }
  const [bin = '', ...args] = fullCommand.split(' ');
  return spawn(bin, args, { stdio: 'inherit' }).catch(() => null);
}

export async function runInstallCommand(
  dep: DepName,
  fullCommand: string,
  deps: DependencyInstallRunnerDeps = {}
): Promise<boolean> {
  const resolved = resolveRunnerDeps(deps);
  tmexLog(resolved.log, t('deps.install.running', { dep }));
  const result = await spawnInstallCommand(fullCommand, resolved.runCommand);
  if (result?.code === 0) {
    return true;
  }
  reportFailedInstall(dep, resolved.error);
  return false;
}

export async function verifyInstalledDependency(
  dep: DepName,
  deps: DependencyInstallRunnerDeps = {}
): Promise<boolean> {
  const resolved = resolveRunnerDeps(deps);
  const check =
    dep === 'bun' ? await resolved.checkBunVersion() : await resolved.checkTmuxVersion();
  if (check.ok) {
    tmexLog(resolved.log, t('deps.install.success', { dep }));
    return true;
  }
  reportFailedInstall(dep, resolved.error);
  return false;
}
