import { afterEach, describe, expect, test } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';
import { UsageError } from './errors';
import { LocalTerminal, TERMINAL_RESET, requireTty } from './term-tty';

interface FakeTty {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  raw(): boolean;
  written(): string;
}

const opened: LocalTerminal[] = [];

afterEach(() => {
  for (const terminal of opened.splice(0)) terminal.stop();
});

function fakeTty(): FakeTty {
  const chunks: Buffer[] = [];
  let raw = false;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: (value: boolean) => {
      raw = value;
      return stdin;
    },
  });
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  }) as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 90, rows: 25 });
  return {
    stdin,
    stdout,
    raw: () => raw,
    written: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function start(tty: FakeTty, exit?: (code: number) => void): LocalTerminal {
  const terminal = new LocalTerminal(
    { stdin: tty.stdin, stdout: tty.stdout },
    exit ? { exit } : {}
  );
  opened.push(terminal);
  terminal.start(
    () => {},
    () => {}
  );
  return terminal;
}

describe('requireTty', () => {
  test('rejects a non-interactive stdio pair with a usage error', () => {
    expect(() =>
      requireTty({
        stdin: { isTTY: false } as NodeJS.ReadStream,
        stdout: { isTTY: false } as NodeJS.WriteStream,
      })
    ).toThrow(UsageError);
  });
});

describe('LocalTerminal', () => {
  test('enters raw mode on start and restores it on stop', () => {
    const tty = fakeTty();
    const terminal = start(tty);
    expect(tty.raw()).toBe(true);
    expect(terminal.size()).toEqual({ cols: 90, rows: 25 });
    terminal.stop();
    expect(tty.raw()).toBe(false);
    expect(tty.written()).toContain(TERMINAL_RESET);
  });

  test('stop is idempotent: the reset string is written exactly once', () => {
    const tty = fakeTty();
    const terminal = start(tty);
    terminal.stop();
    terminal.stop();
    const resets = tty.written().split(TERMINAL_RESET).length - 1;
    expect(resets).toBe(1);
  });

  test('SIGTERM restores the terminal before exiting', () => {
    const tty = fakeTty();
    const codes: number[] = [];
    start(tty, (code) => codes.push(code));
    process.emit('SIGTERM', 'SIGTERM');
    expect(tty.raw()).toBe(false);
    expect(tty.written()).toContain(TERMINAL_RESET);
    expect(codes).toEqual([143]);
  });

  test('SIGHUP restores the terminal too', () => {
    const tty = fakeTty();
    const codes: number[] = [];
    start(tty, (code) => codes.push(code));
    process.emit('SIGHUP', 'SIGHUP');
    expect(tty.raw()).toBe(false);
    expect(codes).toEqual([129]);
  });

  test('stop removes every process listener it installed', () => {
    const before = {
      exit: process.listenerCount('exit'),
      term: process.listenerCount('SIGTERM'),
      hup: process.listenerCount('SIGHUP'),
      winch: process.listenerCount('SIGWINCH'),
    };
    const terminal = start(fakeTty());
    terminal.stop();
    expect(process.listenerCount('exit')).toBe(before.exit);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('SIGHUP')).toBe(before.hup);
    expect(process.listenerCount('SIGWINCH')).toBe(before.winch);
  });
});
