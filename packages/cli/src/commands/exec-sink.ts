// exec 输出文件：同步打开（0600）、背压、关闭时不覆盖原错误。

import { once } from 'node:events';
import { type WriteStream, chmodSync, closeSync, createWriteStream, openSync } from 'node:fs';
import { type FlagValues, flagString } from '../core/args';
import { UsageError } from '../core/errors';
import { concatTail, decodeUtf8Tail } from '../core/exec-client';

export type FileSink = {
  path: string;
  stream: WriteStream;
  error: Error | null;
};

export type ExecFiles = {
  stdoutPath: string | null;
  stderrPath: string | null;
  stdout: FileSink | undefined;
  stderr: FileSink | undefined;
};

export function openSink(path: string, flag: 'stdout-file' | 'stderr-file'): FileSink {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'w', 0o600);
    chmodSync(path, 0o600);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    const detail = error instanceof Error ? error.message : String(error);
    throw new UsageError(`cannot open --${flag} ${path}: ${detail}`);
  }
  const stream = createWriteStream(path, { fd });
  const sink: FileSink = { path, stream, error: null };
  stream.on('error', (err: Error) => {
    sink.error = err;
  });
  return sink;
}

export async function writeSink(sink: FileSink | undefined, bytes: Uint8Array): Promise<void> {
  if (!sink) return;
  if (sink.error) throw sink.error;
  const chunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ok = sink.stream.write(chunk);
  if (!ok) {
    await Promise.race([
      once(sink.stream, 'drain'),
      once(sink.stream, 'error').then((args) => {
        throw args[0];
      }),
    ]);
  }
  if (sink.error) throw sink.error;
}

export async function closeSink(sink: FileSink | undefined): Promise<void> {
  if (!sink) return;
  await new Promise<void>((resolve, reject) => {
    sink.stream.end((error: Error | null | undefined) => {
      if (error) reject(error);
      else resolve();
    });
  });
  if (sink.error) throw sink.error;
}

export function openExecFiles(flags: FlagValues): ExecFiles {
  const stdoutPath = flagString(flags, 'stdout-file') ?? null;
  const stderrPath = flagString(flags, 'stderr-file') ?? null;
  return {
    stdoutPath,
    stderrPath,
    stdout: stdoutPath ? openSink(stdoutPath, 'stdout-file') : undefined,
    stderr: stderrPath ? openSink(stderrPath, 'stderr-file') : undefined,
  };
}

/** 关闭两路文件；返回第一个错误（调用方决定是否覆盖原错误）。 */
export async function closeExecFiles(files: ExecFiles): Promise<unknown> {
  let first: unknown;
  const take = (error: unknown) => {
    if (first === undefined) first = error;
  };
  await closeSink(files.stdout).catch(take);
  await closeSink(files.stderr).catch(take);
  return first;
}

export type CollectOptions = {
  /** false：这一路输出去了文件，不在内存里留副本。 */
  inline: boolean;
  /** 内联部分的字节上限，超出丢弃并标记 truncated。 */
  maxBytes: number;
  /** 只保留最后 N 字节（在 maxBytes 之后生效）。 */
  tailBytes?: number;
};

/** `--json` 收集模式：一路输出的内联副本 + 总字节数。 */
export class StreamCollector {
  bytes = 0;
  truncated = false;
  private kept = 0;
  private readonly chunks: Uint8Array[] = [];
  private tail: Uint8Array = new Uint8Array(0);

  constructor(private readonly options: CollectOptions) {}

  push(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    if (!this.options.inline) return;
    const room = Math.max(0, this.options.maxBytes - this.kept);
    if (chunk.byteLength > room) this.truncated = true;
    const piece = Uint8Array.from(chunk.subarray(0, room));
    if (piece.byteLength === 0) return;
    this.kept += piece.byteLength;
    const limit = this.options.tailBytes;
    if (limit === undefined) {
      this.chunks.push(piece);
      return;
    }
    const next = concatTail(this.tail, piece, limit);
    this.tail = next.bytes;
    if (next.dropped) this.truncated = true;
  }

  text(): string {
    if (this.options.tailBytes !== undefined) return decodeUtf8Tail(this.tail);
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
