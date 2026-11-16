// OpenRC 系统服务的提权执行器：root 直接执行；否则先 `sudo -n`，需要密码时交互式 `sudo -v` 一次。
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { t } from '../i18n';
import { type RunCommandResult, runCommand } from './process';
import type { ServiceDeps } from './service-types';

export class OpenrcPrivilegeError extends Error {}

const SUDO_AUTH_FAILURES = [
  /sudo: (?:a password is required|a terminal is required|no tty present)/i,
  /is not allowed to (?:execute|run)|may not run sudo/i,
];

function isSudoAuthFailure(result: RunCommandResult): boolean {
  return result.code !== 0 && SUDO_AUTH_FAILURES.some((pattern) => pattern.test(result.stderr));
}

const SYSTEM_BIN_DIRS = ['/sbin', '/usr/sbin', '/bin', '/usr/bin'];

export function defaultResolveBin(name: string): string {
  const dirs = [...SYSTEM_BIN_DIRS, ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return join('/sbin', name);
}

export type PrivilegedRun = (argv: string[]) => Promise<RunCommandResult>;

export interface OpenrcRuntime {
  run: NonNullable<ServiceDeps['run']>;
  privileged: PrivilegedRun;
  isRoot: boolean;
  bin: (name: string) => string;
  log: (message: string) => void;
  warn: (message: string) => void;
}

function sudoRequired(argv: string[]): OpenrcPrivilegeError {
  return new OpenrcPrivilegeError(t('service.openrc.sudoRequired', { command: argv.join(' ') }));
}

async function runSudo(run: OpenrcRuntime['run'], argv: string[]): Promise<RunCommandResult> {
  try {
    return await run('sudo', ['-n', ...argv]);
  } catch {
    throw sudoRequired(argv);
  }
}

export function createPrivilegedRun(deps: ServiceDeps = {}): PrivilegedRun {
  const run = deps.run ?? runCommand;
  const euid = deps.euid ?? process.geteuid?.() ?? 0;
  const isInteractive = deps.isInteractive ?? (() => Boolean(process.stdin.isTTY));
  const log = deps.log ?? console.log;
  let escalated = false;
  return async (argv) => {
    if (euid === 0) return await run(argv[0], argv.slice(1));
    const first = await runSudo(run, argv);
    if (!isSudoAuthFailure(first)) return first;
    if (escalated || !isInteractive()) throw sudoRequired(argv);
    log(`[service] ${t('service.openrc.sudoPrompt')}`);
    const validate = await run('sudo', ['-v'], { stdio: 'inherit' }).catch(() => null);
    if (validate?.code !== 0) throw sudoRequired(argv);
    escalated = true;
    const retry = await runSudo(run, argv);
    if (isSudoAuthFailure(retry)) throw sudoRequired(argv);
    return retry;
  };
}

export function createOpenrcRuntime(deps: ServiceDeps = {}): OpenrcRuntime {
  const resolveBin = deps.resolveBin ?? defaultResolveBin;
  return {
    run: deps.run ?? runCommand,
    privileged: createPrivilegedRun(deps),
    isRoot: (deps.euid ?? process.geteuid?.() ?? 0) === 0,
    bin: resolveBin,
    log: deps.log ?? console.log,
    warn: deps.warn ?? console.warn,
  };
}

export function commandDetail(result: RunCommandResult): string {
  return (result.stderr || result.stdout).trim();
}

export async function expectSuccess(
  runtime: OpenrcRuntime,
  argv: string[]
): Promise<RunCommandResult> {
  const result = await runtime.privileged(argv);
  if (result.code !== 0) {
    throw new Error(
      t('service.openrc.commandFailed', { command: argv.join(' '), detail: commandDetail(result) })
    );
  }
  return result;
}
