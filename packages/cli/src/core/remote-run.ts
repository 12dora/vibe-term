// `exec` / `rsh` 共用的远程执行入口：目标解析 → EC1 通道（旧节点回退 `POST /api/exec`）。
// 行为对齐 `ssh host cmd`：stdin 自动转发、输出原样落到本机 fd、退出码由调用方用 exitCodeOf 取。

import type { ReadStream, WriteStream } from 'node:tty';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import type { ExecCommand, ExecOpenSpec, ExecReady } from '@vibeterm/shared/exec-channel';
import type { CliContext } from './context';
import { NotFoundError } from './errors';
import {
  type ExecChannelOptions,
  type ExecChannelResult,
  ExecChannelUnsupportedError,
  runExecChannel,
} from './exec-channel';
import {
  type ExecRoute,
  type ExecTargetPlan,
  ExecTargets,
  legacyTargetText,
  planExecTarget,
} from './exec-target';
import {
  PTY_NOT_ALLOCATED,
  type StdinMode,
  type StdinPlan,
  type Terminal,
  type TtyMode,
  decidePty,
  fdWriter,
  isOutputClosed,
  isTty,
  planStdin,
  processTerminal,
  ptySpec,
} from './remote-run-io';
import { runLegacyExec } from './remote-run-legacy';

export type { StdinMode, Terminal, TtyMode } from './remote-run-io';

export type RemoteRunSinks = {
  stdout: (bytes: Uint8Array) => Promise<void>;
  stderr: (bytes: Uint8Array) => Promise<void>;
};

export type RemoteRunOptions = {
  /** 用户写的目标：`<node>` | `<node>/<device>` | 入口上的 `<device>`。 */
  target: string;
  /** `--node` 覆盖；此时 target 是设备名。 */
  node?: string;
  command: ExecCommand;
  cwd?: string;
  env?: Record<string, string>;
  /** auto：仅登录 shell 且 stdin/stdout 都是 TTY 时分配 PTY；force = -t；always = -tt；no = -T。 */
  tty: TtyMode;
  /** auto：stdin 不是 TTY 时转发（分配了 PTY 则终端即输入）；none = -n。 */
  stdin: StdinMode;
  /** 0 / 缺省 = 不限时。 */
  timeoutMs?: number;
  /** 打印「using device X on node Y」与重连提示（stderr）。 */
  verbose?: boolean;
  /** 缺省（含只给一路）：process.stdout / process.stderr，写满等 drain，EPIPE 视为正常结束。 */
  sinks?: Partial<RemoteRunSinks>;
  /** 目标 node 不支持 exec 通道时回退到 `POST /api/exec`。 */
  legacyFallback: boolean;
  onReady?: (ready: ExecReady) => void;
  /** 测试注入：终端（stdin / stdout / stderr 与 TERM）。 */
  terminal?: Terminal;
  /** 测试注入：假 ws 连接与缩短的计时。 */
  channel?: Pick<ExecChannelOptions, 'connect' | 'timing'>;
};

const UNKNOWN_DEVICE = { id: '', name: '', type: 'local' } as const;

export async function runRemote(
  ctx: CliContext,
  opts: RemoteRunOptions
): Promise<ExecChannelResult> {
  const term = opts.terminal ?? processTerminal();
  const plan = planExecTarget(ctx, opts.target, opts.node);
  const pty = decidePty(opts.tty, opts.command, isTty(term.stdin), isTty(term.stdout));
  if (opts.tty === 'force' && !pty) ctx.out.warn(PTY_NOT_ALLOCATED);
  const stdin = await planStdin(opts.stdin, term, pty);
  return new RemoteRun(ctx, opts, { term, plan, pty, stdin }).run();
}

type Prepared = {
  term: Terminal;
  plan: ExecTargetPlan;
  pty: boolean;
  stdin: StdinPlan;
};

class RemoteRun {
  private readonly targets: ExecTargets;
  private readonly sinks: RemoteRunSinks;
  private readonly startedAt = Date.now();
  /** 当前尝试的 READY；非空即「会话已建立」，之后的错误不再换目标重试。 */
  private ready: ExecReady | null = null;

  constructor(
    private readonly ctx: CliContext,
    private readonly opts: RemoteRunOptions,
    private readonly prep: Prepared
  ) {
    this.targets = new ExecTargets(ctx);
    this.sinks = {
      stdout: opts.sinks?.stdout ?? fdWriter(prep.term.stdout),
      stderr: opts.sinks?.stderr ?? fdWriter(prep.term.stderr),
    };
  }

  async run(): Promise<ExecChannelResult> {
    try {
      return await this.viaChannel();
    } catch (error) {
      if (!(error instanceof ExecChannelUnsupportedError) || !this.opts.legacyFallback) throw error;
      this.targets.forget(this.prep.plan);
      return this.viaLegacy();
    }
  }

  private viaChannel(): Promise<ExecChannelResult> {
    const { plan } = this.prep;
    return plan.kind === 'explicit' ? this.viaExplicit(plan) : this.viaBare(plan.token);
  }

  private async viaExplicit(
    plan: Extract<ExecTargetPlan, { kind: 'explicit' }>
  ): Promise<ExecChannelResult> {
    const first = await this.targets.explicitRoute(plan, false);
    try {
      return await this.attempt(first.route);
    } catch (error) {
      if (!first.cached || !this.retryable(error)) throw error;
    }
    this.targets.forget(plan);
    return this.attempt((await this.targets.explicitRoute(plan, true)).route);
  }

  /** 单段目标：缓存的 node → 入口上的设备 → 按 node 名解析（该 node 的默认设备）。 */
  private async viaBare(token: string): Promise<ExecChannelResult> {
    const cached = this.targets.cachedBareRoute(token);
    if (cached) {
      try {
        return await this.attempt(cached);
      } catch (error) {
        if (!this.retryable(error)) throw error;
        this.targets.forget(this.prep.plan);
      }
    }
    try {
      return await this.attempt({ nodeId: SELF_NODE_ID, nodeName: SELF_NODE_ID, device: token });
    } catch (error) {
      if (!(error instanceof NotFoundError) || this.ready) throw error;
    }
    return this.attempt(await this.targets.bareNodeRoute(token));
  }

  private retryable(error: unknown): boolean {
    const missing = error instanceof NotFoundError || error instanceof ExecChannelUnsupportedError;
    return missing && this.ready === null;
  }

  private spec(device: string | undefined): ExecOpenSpec {
    const { opts, prep } = this;
    return {
      ...(device ? { device } : {}),
      command: opts.command,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env && Object.keys(opts.env).length > 0 ? { env: opts.env } : {}),
      pty: prep.pty ? ptySpec(prep.term) : null,
      stdin: prep.stdin.forward,
      ...(opts.timeoutMs && opts.timeoutMs > 0 ? { timeoutMs: opts.timeoutMs } : {}),
    };
  }

  private async attempt(route: ExecRoute): Promise<ExecChannelResult> {
    const { prep, opts } = this;
    this.ready = null;
    const stream = prep.stdin.open();
    const tty = prep.stdin.useTty
      ? { input: prep.term.stdin as ReadStream, output: prep.term.stdout as WriteStream }
      : null;
    try {
      return await runExecChannel(
        this.ctx,
        route.nodeId,
        this.spec(route.device),
        { stdin: stream, stdout: this.sinks.stdout, stderr: this.sinks.stderr, tty },
        {
          verbose: opts.verbose,
          ...opts.channel,
          onReady: (ready) => this.onReady(ready, route),
        }
      );
    } catch (error) {
      if (isOutputClosed(error)) return this.closedResult();
      throw error;
    } finally {
      prep.stdin.release(stream);
    }
  }

  private onReady(ready: ExecReady, route: ExecRoute): void {
    this.ready = ready;
    if (this.opts.verbose) {
      const line = `using device ${ready.device.name} on node ${route.nodeName}\n`;
      this.ctx.out.rawErr(Buffer.from(line));
    }
    this.opts.onReady?.(ready);
  }

  /** 本地输出端关闭（`| head`）：和 ssh 一样被 SIGPIPE 终止，退出码 141。 */
  private closedResult(): ExecChannelResult {
    return {
      exitCode: null,
      signal: 'SIGPIPE',
      reason: 'killed',
      durationMs: Date.now() - this.startedAt,
      device: this.ready?.device ?? UNKNOWN_DEVICE,
    };
  }

  private async viaLegacy(): Promise<ExecChannelResult> {
    const { prep, opts } = this;
    const stream = prep.stdin.forward ? prep.stdin.open() : null;
    try {
      return await runLegacyExec(this.ctx, {
        target: legacyTargetText(prep.plan),
        command: opts.command,
        cwd: opts.cwd,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
        stdin: prep.stdin.useTty ? null : stream,
        pty: prep.pty,
        verbose: opts.verbose === true,
        sinks: this.sinks,
      });
    } finally {
      prep.stdin.release(stream);
    }
  }
}
