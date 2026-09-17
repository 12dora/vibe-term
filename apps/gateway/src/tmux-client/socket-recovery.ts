// tmux 套接字不可达时的恢复：server 进程还活着（已挂上的控制模式 client 照常收发），
// 只是新起的一次性命令解析不到 socket 路径。tmux(1) 规定此时向 server 发 SIGUSR1 即可重建
// 套接字，但父目录缺失时会失败，所以先按 0700 补目录再发信号，最后轮询确认已可连。
import { dirname } from 'node:path';
import { errorMessage } from '@vibeterm/shared';
import { joinShellArgs, quoteShellArg } from './command-builder';
import { type ControlModeCommandQueue, capturedBlockText } from './control-mode-capture';
import { isTmuxSocketMissingMessage } from './external/helpers';
import type { CommandResult } from './external/types';

/** 每条连接 30 s 内至多尝试一次，避免失败时被每条命令反复触发。 */
export const SOCKET_RECOVERY_MIN_INTERVAL_MS = 30_000;
export const SOCKET_RECOVERY_POLL_INTERVAL_MS = 100;
export const SOCKET_RECOVERY_POLL_TIMEOUT_MS = 1_500;
const SIGNAL_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 3_000;

/** 探针与 pid 查询都用 display-message -p：只写 stdout，不碰状态栏、不改 pane 状态。 */
export const SOCKET_PROBE_ARGV = ['display-message', '-p', '#{pid}'];
const SERVER_PID_COMMAND = 'display-message -p "#{pid}"';
const SOCKET_PATH_COMMAND = 'display-message -p "#{socket_path}"';

const SOCKET_PATH_PATTERN = /error connecting to\s+(.+?)\s*\(/i;

export function parseTmuxSocketPathFromMessage(message: string): string | null {
  const matched = SOCKET_PATH_PATTERN.exec(message);
  const path = matched?.[1]?.trim();
  return path ? path : null;
}

export function parseTmuxServerPid(value: string | null): number | null {
  const pid = Number.parseInt((value ?? '').trim(), 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function buildSocketRecoveryScript(socketPath: string, pid: number): string {
  // -m 只作用于新建目录，不会改动已存在目录的权限。
  return `mkdir -p -m 700 ${quoteShellArg(dirname(socketPath))} && kill -USR1 ${pid}`;
}

export interface SocketRecoveryHost {
  readonly deviceId: string;
  readonly logPrefix: string;
  readonly connected: boolean;
  readonly manualDisconnect: boolean;
  readonly controlCommands: ControlModeCommandQueue;
  getControlWriter(): ((data: string) => void) | null;
  getControlCommandTimeoutMs(): number;
  runTmuxAllowFailure(argv: string[], timeoutMs?: number): Promise<CommandResult>;
}

export interface SocketRecoveryShell {
  runHostShell(
    script: string,
    opts?: { timeoutMs?: number; maxOutputBytes?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface SocketRecoveryOptions {
  minIntervalMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class TmuxSocketRecovery {
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<boolean> | null = null;
  private readonly minIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly host: SocketRecoveryHost,
    private readonly shell: SocketRecoveryShell,
    options: SocketRecoveryOptions = {}
  ) {
    this.minIntervalMs = options.minIntervalMs ?? SOCKET_RECOVERY_MIN_INTERVAL_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? SOCKET_RECOVERY_POLL_INTERVAL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? SOCKET_RECOVERY_POLL_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  }

  /**
   * 进节点会并发打出 select-window / resize-window，本机是两次独立 spawn，会同时看到 socket 不可达。
   * 后到的调用必须等同一次恢复的结果再重试自己的命令，不能被限流当成失败——否则那条命令既没执行又弹告警。
   * 限流只拦「上一次已结束的尝试之后 30 s 内再发一次 SIGUSR1」，作为恢复不了时的死循环闸。
   */
  recreate(socketMessage: string): Promise<boolean> {
    if (!this.host.connected || this.host.manualDisconnect) return Promise.resolve(false);
    if (this.inFlight) return this.inFlight;
    const startedAt = this.now();
    if (startedAt - this.lastAttemptAt < this.minIntervalMs) return Promise.resolve(false);
    this.lastAttemptAt = startedAt;

    const attempt = this.runAttempt(socketMessage).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = attempt;
    return attempt;
  }

  private async runAttempt(socketMessage: string): Promise<boolean> {
    const pid = parseTmuxServerPid(await this.queryControl(SERVER_PID_COMMAND));
    if (!pid) return false;
    const socketPath = await this.resolveSocketPath(socketMessage);
    if (!socketPath) return false;
    if (!(await this.signalServer(socketPath, pid))) return false;
    return this.pollUntilReachable();
  }

  private async resolveSocketPath(socketMessage: string): Promise<string | null> {
    const parsed = parseTmuxSocketPathFromMessage(socketMessage);
    if (parsed) return parsed;
    return (await this.queryControl(SOCKET_PATH_COMMAND))?.trim() || null;
  }

  private async queryControl(command: string): Promise<string | null> {
    const write = this.host.getControlWriter();
    if (!write) return null;
    try {
      return await this.host.controlCommands.execute(write, command, {
        timeoutMs: this.host.getControlCommandTimeoutMs(),
        poisonOnTimeout: false,
        transform: capturedBlockText,
      });
    } catch {
      return null;
    }
  }

  private async signalServer(socketPath: string, pid: number): Promise<boolean> {
    const script = buildSocketRecoveryScript(socketPath, pid);
    try {
      const result = await this.shell.runHostShell(script, { timeoutMs: SIGNAL_TIMEOUT_MS });
      if (result.exitCode === 0) return true;
      this.warn(`SIGUSR1 failed pid=${pid} exit=${result.exitCode}: ${result.stderr.trim()}`);
      return false;
    } catch (error) {
      this.warn(`SIGUSR1 failed pid=${pid}: ${errorMessage(error)}`);
      return false;
    }
  }

  private async pollUntilReachable(): Promise<boolean> {
    const deadline = this.now() + this.pollTimeoutMs;
    for (;;) {
      const probe = await this.host
        .runTmuxAllowFailure(SOCKET_PROBE_ARGV, PROBE_TIMEOUT_MS)
        .catch(() => null);
      if (probe?.exitCode === 0) return true;
      if (this.now() >= deadline) return false;
      await this.sleep(this.pollIntervalMs);
    }
  }

  private warn(detail: string): void {
    console.warn(
      `${this.host.logPrefix} tmux socket recovery deviceId=${this.host.deviceId} ${detail}`
    );
  }
}

export interface SocketRetryHost {
  readonly deviceId: string;
  readonly logPrefix: string;
  readonly connected: boolean;
  readonly manualDisconnect: boolean;
  recreateTmuxSocket(socketMessage: string): Promise<boolean>;
  runTmuxAllowFailure(argv: string[], timeoutMs?: number): Promise<CommandResult>;
}

/**
 * 一次性 tmux 命令因套接字不可达失败时：重建套接字并原样重试一次。
 * 返回 null 表示没救回来，调用方按原有失败路径上报。
 */
export async function retryAfterSocketRecovery(
  host: SocketRetryHost,
  argv: string[],
  message: string,
  timeoutMs: number
): Promise<CommandResult | null> {
  if (!host.connected || host.manualDisconnect || !isTmuxSocketMissingMessage(message)) return null;
  if (!(await host.recreateTmuxSocket(message))) return null;
  const retry = await host.runTmuxAllowFailure(argv, timeoutMs);
  if (retry.exitCode !== 0) return null;
  console.warn(
    `${host.logPrefix} [tmux] socket recreated deviceId=${host.deviceId} argv=${joinShellArgs(argv)}: ${message}`
  );
  return retry;
}
