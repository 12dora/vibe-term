import type { RunCommandMode, RunCommandParams, RunCommandShell } from './run-command';
import { buildPromptRegex, lastNonEmptyLine } from './run-command-text';

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface ResolvedRunCommandArgs {
  command: string;
  mode: RunCommandMode;
  shell: RunCommandShell | undefined;
  timeoutMs: number;
  usePosix: boolean;
  expectPattern: string | undefined;
  promptPattern: string | undefined;
  disablePagingCommand: string | undefined;
}

export function posixExitCodeExpr(shell: RunCommandShell | undefined): string | null {
  switch (shell) {
    case 'fish':
      return '$status';
    case 'powershell':
      return null;
    default:
      return '$?';
  }
}

export function shouldUsePosix(mode: RunCommandMode, shell: RunCommandShell | undefined): boolean {
  if (mode === 'posix') return true;
  if (mode === 'auto') return posixExitCodeExpr(shell) !== null;
  return false;
}

export function resolveRunCommandArgs(params: RunCommandParams): ResolvedRunCommandArgs {
  const mode = params.mode ?? 'auto';
  return {
    command: params.command,
    mode,
    shell: params.shell,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    usePosix: shouldUsePosix(mode, params.shell),
    expectPattern: params.expect,
    promptPattern: params.prompt,
    disablePagingCommand: params.disablePagingCommand,
  };
}

export function compileOptionalRegex(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  return new RegExp(pattern);
}

export function resolvePromptRegex(args: ResolvedRunCommandArgs, screen: string): RegExp | null {
  if (args.promptPattern) {
    return new RegExp(args.promptPattern);
  }
  if (args.mode === 'cli') {
    return buildPromptRegex(lastNonEmptyLine(screen));
  }
  return null;
}
