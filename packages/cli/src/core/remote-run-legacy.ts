// 旧节点（没有 exec 通道）的兼容路径：回退到 `POST /api/exec`。
// 只能跑 shell / argv 命令，stdin 整体缓冲（≤ 740 KiB），输出 8 MiB 封顶。

import type { ExecCommand } from '@vibeterm/shared/exec-channel';
import type { CliContext } from './context';
import { NetworkError, UsageError } from './errors';
import type { ExecChannelResult } from './exec-channel-result';
import {
  EXEC_JSON_BODY_BUDGET,
  EXEC_MAX_MAX_BYTES,
  type ExecRequestBody,
  type ExecResult,
  MAX_EXEC_STDIN_BYTES,
  MAX_EXEC_TIMEOUT_MS,
  mapExecFailure,
  runExecRequest,
} from './exec-client';
import { isOutputClosed } from './remote-run-io';
import { resolveTargetDevice } from './term-target';

const UPGRADE_MESSAGE = '目标节点版本过旧，请先升级该节点';
const COMPAT_WARNING = '目标节点版本过旧，已使用兼容模式（输出上限 8 MiB）；建议升级该节点';

export type LegacySinks = {
  stdout: (bytes: Uint8Array) => Promise<void>;
  stderr: (bytes: Uint8Array) => Promise<void>;
};

export type LegacyRun = {
  /** 旧式目标原文：`<node>/<device>` 或单段。 */
  target: string;
  command: ExecCommand;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin: NodeJS.ReadableStream | null;
  pty: boolean;
  verbose: boolean;
  sinks: LegacySinks;
};

type LegacyLaunch = Pick<ExecRequestBody, 'argv' | 'shell'>;

function launchOf(command: ExecCommand): LegacyLaunch {
  if (command.kind === 'shell') return { argv: [command.script], shell: true };
  if (command.kind === 'argv') return { argv: command.argv };
  throw new UsageError(UPGRADE_MESSAGE);
}

async function readCapped(stream: NodeJS.ReadableStream, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const piece = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    total += piece.byteLength;
    if (total > cap) throw stdinTooLarge();
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

function stdinTooLarge(): UsageError {
  return new UsageError(`${UPGRADE_MESSAGE}（兼容模式的标准输入上限为 740 KiB）`);
}

function stdinField(bytes: Uint8Array): { text: string } | { base64: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { base64: Buffer.from(bytes).toString('base64') };
  }
}

function limits(run: LegacyRun): Pick<ExecRequestBody, 'cwd' | 'env' | 'timeoutMs' | 'maxBytes'> {
  const timeout = run.timeoutMs && run.timeoutMs > 0 ? run.timeoutMs : undefined;
  return {
    maxBytes: EXEC_MAX_MAX_BYTES,
    ...(timeout === undefined ? {} : { timeoutMs: Math.min(timeout, MAX_EXEC_TIMEOUT_MS) }),
    ...(run.cwd ? { cwd: run.cwd } : {}),
    ...(run.env && Object.keys(run.env).length > 0 ? { env: run.env } : {}),
  };
}

async function buildBody(run: LegacyRun, deviceId: string): Promise<ExecRequestBody> {
  const stdin = run.stdin ? await readCapped(run.stdin, MAX_EXEC_STDIN_BYTES) : null;
  const body: ExecRequestBody = {
    deviceId,
    ...launchOf(run.command),
    ...limits(run),
    ...(stdin && stdin.byteLength > 0 ? { stdin: stdinField(stdin) } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(body)) > EXEC_JSON_BODY_BUDGET) throw stdinTooLarge();
  return body;
}

function toChannelResult(
  result: ExecResult,
  device: ExecChannelResult['device']
): ExecChannelResult {
  if (result.reason === 'error') mapExecFailure(result.errorCode, result.errorMessage ?? '');
  if (result.reason !== 'timeout' && result.exitCode === null && result.signal === null) {
    throw new NetworkError('exec ended without an exit status');
  }
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    reason: result.reason === 'timeout' ? 'timeout' : 'exit',
    durationMs: result.durationMs ?? 0,
    device,
  };
}

/** 输出端关闭（EPIPE）后兼容路径的流会以别的错误收场；记下来，收场时还原成「被 SIGPIPE 杀掉」。 */
function trackClosed(sinks: LegacySinks): { sinks: LegacySinks; closed: () => boolean } {
  let closed = false;
  const wrap =
    (write: LegacySinks['stdout']): LegacySinks['stdout'] =>
    async (bytes) => {
      try {
        await write(bytes);
      } catch (error) {
        if (isOutputClosed(error)) closed = true;
        throw error;
      }
    };
  return {
    sinks: { stdout: wrap(sinks.stdout), stderr: wrap(sinks.stderr) },
    closed: () => closed,
  };
}

export async function runLegacyExec(ctx: CliContext, run: LegacyRun): Promise<ExecChannelResult> {
  if (run.pty) throw new UsageError(UPGRADE_MESSAGE);
  launchOf(run.command);
  const resolved = await resolveTargetDevice(ctx, run.target, { notice: run.verbose });
  const device = {
    id: resolved.device.id,
    name: resolved.device.name,
    type: resolved.device.type as 'local' | 'ssh',
  };
  const body = await buildBody(run, device.id);
  ctx.out.warn(COMPAT_WARNING);
  const startedAt = Date.now();
  const tracked = trackClosed(run.sinks);
  try {
    const result = await runExecRequest(ctx, resolved.nodeId, body, { live: tracked.sinks });
    return toChannelResult(result, device);
  } catch (error) {
    if (!tracked.closed()) throw error;
    return {
      exitCode: null,
      signal: 'SIGPIPE',
      reason: 'killed',
      durationMs: Date.now() - startedAt,
      device,
    };
  }
}
