// OpenRC 系统服务的提权执行器：root 直接执行；否则先 `sudo -n`，需要密码时交互式 `sudo -v` 一次。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '../i18n';
import { type RunCommandResult, runCommand } from './process';
import type { ServiceDeps } from './service-types';

export class OpenrcPrivilegeError extends Error {}

// 固定 LC_ALL=C 后 sudo / sudo-rs 的认证失败文案（含 sudo-rs 的拒绝用语）。
const SUDO_AUTH_FAILURES = [
  /(?:a password|interactive authentication|a terminal) is required|no tty present/i,
  /is not allowed to (?:execute|run|authenticate)|is not in the sudoers file|may not run sudo/i,
  /I'm afraid I can't do that|no new privileges|effective uid is not 0/i,
];

// sudo 放行后 rc-service 自己的输出：status 对已停服务返回 3，不存在的服务报 does not exist。
const RC_SERVICE_RAN = /\bstatus:|rc-service|does not exist/i;

export function isSudoAuthFailure(result: RunCommandResult): boolean {
  return result.code !== 0 && SUDO_AUTH_FAILURES.some((pattern) => pattern.test(result.stderr));
}

/** 以 root 执行或写进 sudoers 的命令只从固定系统目录解析，绝不读用户 PATH。 */
const SYSTEM_BIN_DIRS = ['/sbin', '/usr/sbin', '/bin', '/usr/bin'];

export function defaultResolveBin(name: string): string {
  for (const dir of SYSTEM_BIN_DIRS) {
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

const SUDO_ENV = { LC_ALL: 'C', LANG: 'C' };

function sudoRequired(argv: string[]): OpenrcPrivilegeError {
  return new OpenrcPrivilegeError(t('service.openrc.sudoRequired', { command: argv.join(' ') }));
}

async function runSudo(run: OpenrcRuntime['run'], argv: string[]): Promise<RunCommandResult> {
  try {
    return await run('sudo', ['-n', ...argv], { env: { ...process.env, ...SUDO_ENV } });
  } catch {
    throw sudoRequired(argv);
  }
}

/**
 * 免密规则是否就绪：`-k` 忽略缓存的 sudo 凭据，避免刚交互输过密码时误判；
 * 只有 rc-service 真正执行了（退出 0，或输出里能看到 rc-service 自己的状态文案）才算可用。
 */
export async function probeNopasswd(run: OpenrcRuntime['run'], argv: string[]): Promise<boolean> {
  try {
    const result = await run('sudo', ['-n', '-k', ...argv], {
      env: { ...process.env, ...SUDO_ENV },
    });
    if (isSudoAuthFailure(result)) return false;
    return result.code === 0 || RC_SERVICE_RAN.test(`${result.stdout}\n${result.stderr}`);
  } catch {
    return false;
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
