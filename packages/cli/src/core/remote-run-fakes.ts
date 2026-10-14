// runRemote / exec 单测共用：假终端与旧 `POST /api/exec` 的 NDJSON 响应。只被 *.test.ts import，不进 bundle。

import { Readable, Writable } from 'node:stream';
import type { Terminal } from './remote-run-io';

export type FakeTerminalOptions = {
  stdin?: Readable;
  stdinTty?: boolean;
  stdoutTty?: boolean;
  term?: string;
  /** stdout 的写入回调；用来模拟背压 / EPIPE。 */
  writeStdout?: (chunk: Buffer, callback: (error?: Error | null) => void) => void;
};

export function fakeTerminal(options: FakeTerminalOptions = {}) {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const rawModes: boolean[] = [];
  const stream = (
    sink: Buffer[],
    tty: boolean,
    write?: FakeTerminalOptions['writeStdout']
  ): NodeJS.WriteStream =>
    Object.assign(
      new Writable({
        write(chunk, _encoding, callback) {
          sink.push(Buffer.from(chunk));
          if (write) write(Buffer.from(chunk), callback);
          else callback();
        },
      }),
      { isTTY: tty, columns: 100, rows: 30 }
    ) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(options.stdin ?? Readable.from([]), {
    isTTY: options.stdinTty === true,
    isRaw: false,
    setRawMode: (mode: boolean) => {
      rawModes.push(mode);
    },
  }) as unknown as NodeJS.ReadStream;
  const term: Terminal = {
    stdin,
    stdout: stream(out, options.stdoutTty === true, options.writeStdout),
    stderr: stream(err, false),
    ...(options.term ? { term: options.term } : {}),
  };
  return {
    term,
    rawModes,
    stdout: () => Buffer.concat(out),
    stderr: () => Buffer.concat(err),
  };
}

export function ndjsonResponse(events: unknown[], status = 200): Response {
  return new Response(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
    status,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

export const LEGACY_EXIT = {
  type: 'exit',
  code: 0,
  signal: null,
  durationMs: 1,
  truncated: { stdout: false, stderr: false },
};

export const LEGACY_DEVICE = {
  id: 'dev-1',
  name: 'laptop',
  type: 'local',
  sortOrder: 0,
  authMode: 'auto',
  createdAt: '',
  updatedAt: '',
};
