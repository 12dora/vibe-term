// exec 通道客户端的公开类型与退出码映射。

import type { ReadStream, WriteStream } from 'node:tty';
import type { ExecReady } from '@vibeterm/shared/exec-channel';
import type { ExecChannelTiming } from './exec-channel-conn';
import { signalNumber } from './exec-channel-pty';
import type { ExecSocketConnect } from './exec-channel-socket';

export type ExecChannelIo = {
  stdin: NodeJS.ReadableStream | null;
  stdout: (bytes: Uint8Array) => Promise<void> | void;
  stderr: (bytes: Uint8Array) => Promise<void> | void;
  tty: { input: ReadStream; output: WriteStream } | null;
};

export type ExecChannelResult = {
  exitCode: number | null;
  signal: string | null;
  reason: 'exit' | 'timeout' | 'killed';
  durationMs: number;
  device: { id: string; name: string; type: 'local' | 'ssh' };
};

export type ExecChannelOptions = {
  verbose?: boolean;
  onReady?: (ready: ExecReady) => void;
  /** 测试注入：替换真实的 ws 连接。 */
  connect?: ExecSocketConnect;
  /** 测试注入：缩短保活 / ACK / 退避时间。 */
  timing?: Partial<ExecChannelTiming>;
};

export function exitCodeOf(result: ExecChannelResult): number {
  if (result.reason === 'timeout') return 124;
  if (result.signal) {
    const signo = signalNumber(result.signal);
    return signo === null ? 255 : 128 + signo;
  }
  return result.exitCode ?? 255;
}
