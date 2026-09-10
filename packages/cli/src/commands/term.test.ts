import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { GatewayPaneScreenSnapshot } from '@vibeterm/ws-client';
import type { CliError } from '../core/errors';
import { UsageError } from '../core/errors';
import { runAttach } from '../core/term-attach';
import { parseDetachKey } from '../core/term-escape';
import { type FakeTermContext, createFakeTermContext, fakeSession } from '../core/term-test-fakes';
import { command as term } from './term';

const dirs: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness(options: { json?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-term-'));
  dirs.push(dir);
  return createFakeTermContext({
    session: fakeSession(),
    configDir: dir,
    json: options.json ?? false,
    timeoutMs: 1_500,
  });
}

function screenFor(paneId: string, text: string): GatewayPaneScreenSnapshot {
  return {
    deviceId: 'device-1',
    paneId,
    paneEpoch: new Uint8Array(16).fill(7),
    baseSeq: 42n,
    rows: 24,
    cols: 80,
    modes: 0,
    data: encoder.encode(text),
    historyCursor: null,
  };
}

/** 假网关：收到 RequestScreen 就回一屏；`onInput` 让用例决定回什么字节。 */
function autoScreen(
  h: FakeTermContext,
  screenText: string,
  onInput?: (data: string, emitData: (bytes: string) => void) => void
): void {
  const emitData = (paneId: string) => (bytes: string) => {
    h.transport.emit({
      type: 'terminal-data',
      frame: { deviceId: 'device-1', paneId, data: encoder.encode(bytes) },
    });
  };
  h.transport.onCommand = (command) => {
    if (command.type === 'request-pane-screen') {
      h.transport.emit({
        type: 'screen-snapshot',
        snapshot: screenFor(command.paneId, screenText),
      });
      return;
    }
    if (command.type === 'terminal-input') onInput?.(command.data, emitData(command.paneId));
  };
}

describe('vibeterm term send', () => {
  test('subscribes, takes a screen baseline and sends the key bytes', async () => {
    const h = await harness({ json: true });
    autoScreen(h, 'prompt$ ', (_data, emit) => emit('echo hi'));
    await term.run(h.ctx, ['send', 'laptop:build.1', 'echo hi', 'Enter']);
    expect(h.transport.commandsOfType('set-pane-subscriptions')[0]).toMatchObject({
      paneIds: ['%2'],
    });
    expect(h.transport.commandsOfType('terminal-input')[0]).toMatchObject({
      paneId: '%2',
      data: 'echo hi\r',
    });
    expect(JSON.parse(h.stdout.text())).toEqual({
      ok: true,
      pane: '%2',
      bytes: 8,
      echoed: true,
    });
  });

  test('--hex sends the decoded bytes', async () => {
    const h = await harness();
    autoScreen(h, '');
    await term.run(h.ctx, ['send', 'laptop', '--hex', '1b5b41']);
    expect(h.transport.commandsOfType('terminal-input')[0].data).toBe('\u001b[A');
  });

  test('keys are required unless --stdin is used', async () => {
    const h = await harness();
    await expect(term.run(h.ctx, ['send', 'laptop'])).rejects.toThrow(UsageError);
  });
});

describe('vibeterm term capture', () => {
  test('--json carries the raw screen and the scrubbed text', async () => {
    const h = await harness({ json: true });
    autoScreen(h, '\u001b[2J\u001b[Hhello\nworld   \n');
    await term.run(h.ctx, ['capture', 'laptop']);
    const payload = JSON.parse(h.stdout.text()) as Record<string, unknown>;
    expect(payload.pane).toBe('%0');
    expect(payload.seq).toBe('42');
    expect(payload.text).toBe('hello\nworld');
    expect(Buffer.from(String(payload.screen), 'base64').toString('utf8')).toContain('hello');
  });

  test('--strip-ansi prints plain text', async () => {
    const h = await harness();
    autoScreen(h, '\u001b[31mred\u001b[0m\n');
    await term.run(h.ctx, ['capture', 'laptop', '--strip-ansi']);
    expect(h.stdout.text()).toBe('red\n');
  });
  test('--history fetches one scrollback page alongside the screen', async () => {
    const h = await harness({ json: true });
    h.transport.onCommand = (command) => {
      if (command.type === 'request-pane-screen') {
        h.transport.emit({
          type: 'screen-snapshot',
          snapshot: {
            ...screenFor(command.paneId, 'now'),
            historyCursor: {
              paneEpoch: new Uint8Array(16).fill(7),
              historyEpoch: new Uint8Array(16).fill(9),
              beforeLine: 40,
            },
          },
        });
        return;
      }
      if (command.type !== 'request-pane-history') return;
      h.transport.emit({
        type: 'history-page',
        page: {
          deviceId: 'device-1',
          paneId: command.paneId,
          paneEpoch: new Uint8Array(16).fill(7),
          historyEpoch: new Uint8Array(16).fill(9),
          lineStart: 20,
          lineEnd: 40,
          truncated: false,
          data: encoder.encode('older\n'),
          nextCursor: null,
        },
      });
    };
    await term.run(h.ctx, ['capture', 'laptop', '--history', '4096']);
    const payload = JSON.parse(h.stdout.text()) as { history?: { text: string } };
    expect(payload.history?.text).toBe('older');
    expect(h.transport.commandsOfType('request-pane-history')[0]).toMatchObject({
      byteLimit: 4096,
    });
  });

  test('--wait-idle takes a second screen after the pane goes quiet', async () => {
    const h = await harness();
    autoScreen(h, 'settled');
    await term.run(h.ctx, ['capture', 'laptop', '--wait-idle', '30', '--strip-ansi']);
    expect(h.transport.commandsOfType('request-pane-screen').length).toBe(2);
    expect(h.stdout.text()).toBe('settled\n');
  });
});

describe('vibeterm term stream recovery', () => {
  test('a rebase re-requests the screen so PaneData starts flowing again', async () => {
    const h = await harness();
    autoScreen(h, 'S');
    const stream = { done: false };
    h.transport.onCommand = (command) => {
      if (command.type !== 'request-pane-screen') return;
      h.transport.emit({ type: 'screen-snapshot', snapshot: screenFor(command.paneId, 'S') });
      if (stream.done) return;
      stream.done = true;
      // 订阅落地后网关会先把 pane 拦住并要求重取一次画面。
      queueMicrotask(() =>
        h.transport.emit({
          type: 'rebase-required',
          deviceId: 'device-1',
          paneId: '%0',
          reason: 'cache_evicted',
        })
      );
    };
    await term.run(h.ctx, ['capture', 'laptop']);
    expect(h.transport.commandsOfType('request-pane-screen').length).toBeGreaterThan(1);
  });

  test('a screen that never arrives is a network failure, not empty output', async () => {
    const h = await harness();
    const failed = await term.run(h.ctx, ['capture', 'laptop']).then(
      () => null,
      (error) => error as CliError
    );
    expect(failed?.exitCode).toBe(5);
    expect(h.closed()).toBe(1);
  });

  test('losing the socket mid-run fails instead of looking like silence', async () => {
    const h = await harness();
    autoScreen(h, 'S', () => {
      queueMicrotask(() => h.transport.emit({ type: 'connection-state', state: 'CLOSED' }));
    });
    const failed = await term.run(h.ctx, ['run', 'laptop', 'sleep 9']).then(
      () => null,
      (error) => error as CliError
    );
    expect(failed?.exitCode).toBe(5);
  });
});

describe('vibeterm term run', () => {
  test('--marker detects completion and the exit code', async () => {
    const h = await harness({ json: true });
    // 哨兵是第二行输入：先回显命令与它的输出，收到哨兵行再回显它与结果。
    autoScreen(h, 'prompt$ ', (data, emit) => {
      const nonce = /__VT_DONE_([0-9a-f]+)_/.exec(data)?.[1];
      if (!nonce) {
        emit(`${data.trimEnd()}\r\nhello\r\n`);
        return;
      }
      emit(`${data.trimEnd()}\r\n__VT_DONE_${nonce}_0\r\nprompt$ `);
    });
    await term.run(h.ctx, ['run', 'laptop', 'echo hello', '--marker']);
    const payload = JSON.parse(h.stdout.text()) as Record<string, unknown>;
    expect(payload.reason).toBe('done');
    expect(payload.exitCode).toBe(0);
    expect(payload.output).toBe('hello');
    expect(payload.command).toBe('echo hello');
  });

  test('without a marker it stops on silence and strips the prompt', async () => {
    const h = await harness();
    autoScreen(h, 'prompt$ ', (data, emit) => emit(`${data.trimEnd()}\r\nhello\r\nuser@host ~ % `));
    await term.run(h.ctx, ['run', 'laptop', 'echo hello', '--idle', '30']);
    expect(h.stdout.text()).toBe('hello\n');
  });

  test('a command is required', async () => {
    const h = await harness();
    await expect(term.run(h.ctx, ['run', 'laptop'])).rejects.toThrow(UsageError);
  });
});

describe('vibeterm term attach', () => {
  test('refuses to run without a TTY and points at the scriptable commands', async () => {
    const h = await harness();
    const streams = {
      stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: { isTTY: false } as NodeJS.WriteStream,
    };
    const thrown = await runAttach(
      h.ctx,
      'laptop',
      { detachKey: parseDetachKey('~.'), historyBytes: 0 },
      streams
    ).then(
      () => null,
      (err) => err as UsageError
    );
    expect(thrown).toBeInstanceOf(UsageError);
    expect(thrown?.exitCode).toBe(2);
    expect(thrown?.hint).toContain('term run');
  });
});

function ttyStreams(): {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  written(): string;
} {
  const chunks: Buffer[] = [];
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  }) as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 30 });
  return { stdin, stdout, written: () => Buffer.concat(chunks).toString('utf8') };
}

describe('vibeterm term attach on a fake TTY', () => {
  test('paints the screen, forwards keys, resizes and detaches on ~.', async () => {
    const h = await harness();
    autoScreen(h, 'SCREEN-CONTENT', (_data, emit) => emit('echoed'));
    const tty = ttyStreams();
    const attached = runAttach(
      h.ctx,
      'laptop',
      { detachKey: parseDetachKey('~.'), historyBytes: 0 },
      { stdin: tty.stdin, stdout: tty.stdout }
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    tty.stdin.push('ls\r');
    await new Promise((resolve) => setTimeout(resolve, 20));
    tty.stdin.push('~.');
    expect(await attached).toBe(0);

    expect(tty.written()).toContain('SCREEN-CONTENT');
    expect(tty.written()).toContain('echoed');
    expect(tty.written()).toContain('[vibeterm] detached');
    expect(h.transport.commandsOfType('terminal-input')[0]).toMatchObject({ data: 'ls\r' });
    expect(h.transport.commandsOfType('terminal-resize')[0]).toMatchObject({
      cols: 100,
      rows: 30,
      paneId: '%0',
    });
    expect(h.closed()).toBe(1);
  });
});

describe('vibeterm term attach failure handling', () => {
  test('an exception while writing pane data ends the attach and restores the TTY', async () => {
    const h = await harness();
    autoScreen(h, 'S');
    const tty = ttyStreams();
    let raw = true;
    Object.assign(tty.stdin, {
      setRawMode: (value: boolean) => {
        raw = value;
        return tty.stdin;
      },
    });
    let boom = true;
    const stdout = tty.stdout as unknown as { write: (chunk: unknown) => boolean };
    const original = stdout.write.bind(stdout);
    stdout.write = (chunk: unknown) => {
      if (boom) {
        boom = false;
        throw new Error('tty exploded');
      }
      return original(chunk);
    };
    const failed = await runAttach(
      h.ctx,
      'laptop',
      { detachKey: parseDetachKey('~.'), historyBytes: 0 },
      { stdin: tty.stdin, stdout: tty.stdout }
    ).then(
      () => null,
      (error) => error as Error
    );
    expect(failed?.message).toContain('tty exploded');
    expect(raw).toBe(false);
    expect(h.closed()).toBe(1);
  });
});

describe('vibeterm term dispatch', () => {
  test('unknown subcommands and missing targets are usage errors', async () => {
    const h = await harness();
    await expect(term.run(h.ctx, ['teleport', 'laptop'])).rejects.toThrow(UsageError);
    await expect(term.run(h.ctx, ['capture'])).rejects.toThrow(UsageError);
    await expect(term.run(h.ctx, [])).rejects.toThrow(UsageError);
  });
});
