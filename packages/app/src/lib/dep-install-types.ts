import { type RunCommandResult, runCommand } from './process';

export type DepName = 'bun' | 'tmux';

export interface InstallCommand {
  label: string;
  command: string;
  requiresSudo: boolean;
  packageManager: string;
}

export interface DepInstallPlan {
  dep: DepName;
  commands: InstallCommand[];
  currentVersion?: string;
  requiredVersion: string;
  issue: 'missing' | 'version-too-low';
}

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

export function isRootUid(uid: number | undefined): boolean {
  return uid === 0;
}

export function resolveInstallCommand(
  cmd: InstallCommand,
  uid: number | undefined = process.getuid?.()
): string {
  if (!cmd.requiresSudo) return cmd.command;
  if (isRootUid(uid)) return cmd.command;
  return `sudo ${cmd.command}`;
}

export async function isSudoAvailable(): Promise<boolean> {
  const result = await runCommand('sudo', ['-n', 'true'], {
    stdio: 'pipe',
    timeoutMs: 5000,
  }).catch(() => null);
  return result !== null && result.code === 0;
}
